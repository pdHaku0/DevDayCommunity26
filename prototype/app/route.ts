export function GET() {
  return Response.json({
    service: "dot-link",
    mcp: "/mcp",
    status: "prototype",
  });
}
