// Read-only diagnostics. Never print keys, message data, invitation URLs or tokens.
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROTOCOL, checkIdentity, unb64, validateRelay } from './protocol.mjs';

const report = {
  request_id: randomUUID(),
  scope: 'endpoint_and_optional_public_site',
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  checks: [],
  not_checked: ['Sites account quota and permissions', 'MCP authentication', 'MCP Events execution', 'peer delivery'],
};
const add = (check, status, code, message, details = {}) =>
  report.checks.push({ check, status, code, message, ...details });
let state;
let relay;
const args = process.argv.slice(2);
const remote = args.includes('--remote');
let argumentsValid = true;
try {
  if (args.some((a, i) => a !== '--remote' && a !== '--site' && args[i - 1] !== '--site') ||
      args.filter(a => a === '--site').length > 1 || args.filter(a => a === '--remote').length > 1)
    throw new Error('arguments');
  const siteIndex = args.indexOf('--site');
  if (siteIndex !== -1) relay = validateRelay(args[siteIndex + 1]);
} catch {
  argumentsValid = false;
  add('arguments', 'error', 'invalid_arguments', 'Usage: node scripts/doctor.mjs [--remote] [--site OWN_SITE_ORIGIN]');
}
try {
  if (argumentsValid) {
  const version = process.versions.node.split('.').map(Number);
  add('runtime', version[0] > 22 || version[0] === 22 && version[1] >= 13 ? 'ok' : 'error',
    'node_version', 'Node.js 22.13以上が必要です。');
  try {
    import.meta.resolve('libsodium-wrappers');
    add('dependency', 'ok', 'dependency_found', '暗号ライブラリの配置を確認しました。');
  } catch {
    add('dependency', 'error', 'dependency_missing', 'Skillのディレクトリでnpm ciを実行してください。');
  }
  const dir = process.env.DOT_LINK_HOME || join(homedir(), '.local', 'share', 'dot-link-federated');
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      add('state', 'error', 'state_directory_invalid', '保存先が通常のディレクトリではありません。既存データを変更せず保存先を確認してください。');
    } else {
      if (process.platform !== 'win32' && (info.mode & 0o077))
        add('state_permissions', 'error', 'directory_permissions', '鍵の保存先を他の利用者が読める権限になっています。');
      try {
        const lock = await lstat(join(dir, '.lock'));
        if (lock) add('lock', 'warning', 'state_locked', '処理ロックがあります。実行中の処理を確認し、停止済みと分かるまで削除しないでください。');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const file = join(dir, 'state.json');
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
        add('state', 'error', 'state_file_invalid', '状態ファイルが通常のファイルではありません。');
      } else if (fileInfo.size > 32 * 1024 * 1024) {
        add('state', 'warning', 'state_not_inspected', '状態ファイルが大きいため、この診断では中身を検査していません。', { bytes: fileInfo.size });
      } else {
        if (process.platform !== 'win32' && (fileInfo.mode & 0o077))
          add('state_permissions', 'error', 'file_permissions', '鍵の状態ファイルを他の利用者が読める権限になっています。');
        const stored = await readFile(file, 'utf8');
        try { state = JSON.parse(stored); }
        catch { add('state', 'error', 'state_unreadable', '状態ファイルをJSONとして読めません。鍵を作り直さず、保存済みファイルを調査してください。'); }
        if (state) {
          if (state.protocol !== PROTOCOL) {
            add('state', 'error', 'state_format_mismatch', '状態ファイルが現在の形式と一致しません。旧ファイルを消さず、新形式用の保存先を確認してください。');
          } else {
            try {
              await checkIdentity(state.identity);
              unb64(state.identity.boxSecret, 32);
              unb64(state.identity.signSecret, 64);
              add('state', 'ok', 'identity_valid', '公開鍵・識別子・保存形式を確認しました。秘密鍵の対応関係や実通信は別途検証が必要です。');
              if (relay && relay !== state.identity.relay)
                add('site', 'error', 'site_mismatch', '指定Siteと、この端点が登録するSiteが一致しません。');
              relay ??= state.identity.relay;
            } catch {
              add('state', 'error', 'identity_invalid', '保存された鍵の形式・識別子・Site設定が整合しません。既存状態を保持して調査してください。');
            }
          }
        }
      }
    }
  } catch (e) {
    add('state', 'error', e.code === 'ENOENT' ? 'state_missing' : 'state_access_failed',
      e.code === 'ENOENT' ? 'この実行環境の保存先に状態がありません。別の保存先や実行環境を確認してから初期化してください。' : '状態ファイルを読み取れません。保存先とファイル権限を確認してください。',
      { os_code: ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(e.code) ? e.code : 'unknown' });
  }
  if (remote) {
    if (!relay) add('site', 'error', 'site_unknown', '公開先が不明です。公開成功時の自分のSiteを--siteで指定してください。');
    else {
      try {
        const response = await fetch(relay + '/', { redirect: 'manual', signal: AbortSignal.timeout(8000) });
        const status = response.status;
        if (status !== 200) {
          await response.body?.cancel();
          add('site', 'error', 'site_http_error', '自分のSiteから正常な公開応答が得られませんでした。このHTTP状態だけでは、利用上限や権限の原因は確定できません。', { http_status: status });
        } else {
          const reader = response.body?.getReader();
          let text = '', size = 0;
          if (!reader) throw new Error('invalid_response');
          for (;;) {
            const {done, value} = await reader.read(); if (done) break;
            size += value.length;
            if (size > 8192) { await reader.cancel(); throw new Error('invalid_response'); }
            text += new TextDecoder().decode(value, { stream: true });
          }
          let result;
          try { result = JSON.parse(text); } catch { throw new Error('invalid_response'); }
          if (result?.service !== PROTOCOL || result?.federation !== '/api/federation') throw new Error('invalid_response');
          add('site', 'ok', 'site_reachable', '現在の形式の公開Siteへ到達できました。Plugin認証やイベント起動の成功を意味しません。', { http_status: status });
        }
      } catch (e) {
        add('site', 'error', e.name === 'TimeoutError' ? 'site_timeout' : e.message === 'invalid_response' ? 'site_unexpected_response' : 'site_network_error',
          e.name === 'TimeoutError' ? '公開Siteへの確認が時間切れになりました。' : e.message === 'invalid_response' ? '応答が現在のDot Link形式ではありません。公開バージョンを確認してください。' : '公開Siteへの接続に失敗しました。ネットワークか公開先かは、この結果だけでは特定できません。');
      }
    }
  }
  }
} catch {
  add('diagnostic', 'error', 'diagnostic_failed', '診断処理を完了できませんでした。状態を変更せず、実行環境を確認してください。');
}
report.ok = !report.checks.some(c => c.status === 'error');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
