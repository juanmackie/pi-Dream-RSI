import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer((request, response) => {
  if (request.method === "POST" && /^\/capture\/(dark|light)$/.test(request.url ?? "")) {
    const name = request.url.split("/").at(-1);
    const parts = [];
    let size = 0;
    request.on("data", (part) => { size += part.length; if (size > 2_000_000) request.destroy(); else parts.push(part); });
    request.on("end", () => {
      const bytes = Buffer.from(Buffer.concat(parts).toString("utf8"), "base64");
      if (bytes[0] !== 255 || bytes[1] !== 216) { response.writeHead(400); response.end("Expected JPEG"); return; }
      fs.writeFileSync(path.join(root, `dashboard-${name}.jpg`), bytes);
      response.end(`Saved dashboard-${name}.jpg`);
    });
    return;
  }
  const name = request.url === "/light" ? "dashboard-light.html" : request.url === "/dark" ? "dashboard-dark.html" : null;
  if (!name) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(fs.readFileSync(path.join(root, name)));
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
