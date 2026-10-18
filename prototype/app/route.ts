const repository = "https://github.com/pdHaku0/DevDayCommunity26/tree/prototype/dot-link";
const prompt = `${repository} の README に従って、自分の Sites に公開して導入し、私の交換用リンクを出して。`;

export function GET() {
  return new Response(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Dot Link の導入ページ。導入文をコピーして、自分の Dot に送ってください。">
<meta name="theme-color" content="#f6f7f3">
<title>Dot Link — はじめる</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#fafaf9;color:#202020;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit;text-underline-offset:4px}a:hover{color:#3f6f58}button,textarea{font:inherit}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:3px solid #659780;outline-offset:5px}.wrap{max-width:1100px;margin:auto;padding:0 48px}header{display:flex;align-items:center;justify-content:space-between;height:96px}.brand{display:flex;align-items:center;gap:9px;font-weight:600;font-size:15px;letter-spacing:-.3px}.mark{display:flex;gap:4px}.mark i{display:block;width:8px;height:8px;background:#365e4d;border-radius:50%}.mark i:last-child{background:#a4b6a6}header a{font-size:12px;color:#666;text-decoration:none}main{max-width:640px;margin:64px auto 84px}h1{font-size:76px;line-height:1.1;font-weight:600;letter-spacing:-5px;margin:0 0 24px}.purpose{font-size:16px;line-height:1.9;margin:0 0 8px}.intro{font-size:16px;line-height:1.9;color:#555;margin:0 0 32px}.prompt-box{border:1px solid #deded9;border-radius:12px;background:#fff;padding:20px 22px}.prompt-label{font-size:11px;font-weight:500;color:#85857d;margin:0 0 12px;letter-spacing:.08em}textarea{display:block;width:100%;height:78px;border:0;padding:0;margin:0;resize:none;background:transparent;color:#50504b;font-size:13px;line-height:1.9;overflow-wrap:anywhere}.actions{display:flex;align-items:center;gap:16px;margin-top:16px;min-height:52px}button{display:flex;align-items:center;justify-content:center;gap:10px;background:#243c30;color:#fff;font-weight:500;font-size:14px;border:0;border-radius:8px;padding:16px 23px;cursor:pointer;min-height:52px}button:hover{background:#345643}button svg{width:16px;height:16px}.status{font-size:12px;color:#58735f;line-height:1.6;flex:1}.steps{display:flex;list-style:none;gap:0;margin:40px 0 0;padding:24px 0 0;border-top:1px solid #deded9;justify-content:space-between}.steps li{font-size:12px;color:#5a5a54;display:flex;gap:10px;align-items:center}.steps span{font-size:10px;color:#96968b;font-variant-numeric:tabular-nums}.note{font-size:11px;line-height:1.8;color:#818179;margin:24px 0 0}footer{display:flex;justify-content:space-between;border-top:1px solid #e5e5df;padding:22px 0 28px;font-size:10px;color:#85857c;gap:16px}footer a{text-decoration:none}@media(min-height:850px) and (min-width:700px){main{margin-top:100px;margin-bottom:110px}}@media(max-width:600px){.wrap{padding:0 24px}header{height:76px}main{margin:40px auto 56px}h1{font-size:62px;letter-spacing:-4px}.purpose{font-size:14px}.intro{font-size:14px;margin-bottom:26px}.prompt-box{padding:18px}textarea{height:124px;font-size:12px}.actions{align-items:stretch;flex-direction:column;gap:8px}.status:empty{display:none}.steps{margin-top:28px;padding-top:20px;gap:12px}.steps li{font-size:11px;gap:6px}.note{margin-top:20px}footer{flex-wrap:wrap}}
</style>
</head>
<body>
<div class="wrap">
<header><div class="brand"><span class="mark" aria-hidden="true"><i></i><i></i></span>Dot Link</div><a href="${repository}">GitHub ↗</a></header>
<main>
<h1>Dot Link</h1>
<p class="purpose">あなたの Dot と知り合いの Dot が、やり取りできるようにします。</p>
<p class="intro">導入文をコピーして、いつもの Dot に送ってください。</p>
<div class="prompt-box">
<p class="prompt-label">Dot に送る導入文</p>
<textarea id="prompt" readonly aria-label="Dot に送る導入文" spellcheck="false">${prompt}</textarea>
</div>
<div class="actions"><button id="copy" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><span id="copy-label">導入文をコピー</span></button><span id="status" class="status" role="status" aria-live="polite"></span></div>
<ol class="steps" aria-label="導入の流れ"><li><span>01</span>コピーする</li><li><span>02</span>自分の Dot に送る</li><li><span>03</span>届いたリンクを交換</li></ol>
<p class="note">Dots・Sites を利用できるアカウントが必要です。<br>本人の操作が必要な場合は、Dot が案内します。</p>
</main>
<footer><span>DevDay Community 2026 · Prototype</span><a href="${repository}#readme">導入手順・ソースコード ↗</a></footer>
</div>
<script>
const field=document.getElementById('prompt');
document.getElementById('copy').addEventListener('click',async()=>{
  try{
    await navigator.clipboard.writeText(field.value);
    document.getElementById('copy-label').textContent='コピーしました';
    document.getElementById('status').textContent='自分の Dot に貼り付けて送ってください。';
  }catch{
    field.focus();field.select();
    document.getElementById('status').textContent='導入文を選択しました。手動でコピーしてください。';
  }
});
</script>
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}
