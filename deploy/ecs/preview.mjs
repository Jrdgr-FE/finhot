// Read-only, loopback preview through the authenticated Workbench session.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const instance = process.env.FINHOT_ECS_INSTANCE;
const region = process.env.FINHOT_ECS_REGION ?? "cn-guangzhou";
if (!/^i-[a-z0-9]+$/.test(instance ?? "")) throw new Error("FINHOT_ECS_INSTANCE is required");
const cache = new Map();
let active = 0;
const waiters = [];
async function acquire() { if (active >= 2) await new Promise(resolve => waiters.push(resolve)); active++; }
function release() { active--; waiters.shift()?.(); }
const server = createServer(async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method) || (req.url?.length ?? 0) > 4096) { res.writeHead(405); res.end("Read-only preview"); return; }
  const u = new URL(req.url, "http://127.0.0.1");
  const route = u.pathname + u.search;
  const staticAsset = u.pathname.startsWith("/assets/") || /\.(png|ico|svg|woff2?)$/.test(u.pathname);
  await acquire();
  try {
    let result = staticAsset ? cache.get(route) : null;
    if (!result) {
      const payload = Buffer.from(JSON.stringify(route)).toString("base64");
      const command = `python3 - <<'PY'\nimport urllib.request,urllib.error,json,base64\np=json.loads(base64.b64decode('${payload}'))\ntry:r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8080'+p,headers={'User-Agent':'FinHotDeploymentPreview/1.0'}),timeout=20)\nexcept urllib.error.HTTPError as e:r=e\nb=r.read(8000000)\nprint(json.dumps({'status':r.status,'headers':{'content-type':r.headers.get('content-type','application/octet-stream')},'data':base64.b64encode(b).decode()}))\nPY`;
      const { stdout } = await exec("workbench", ["exec", "-i", instance, "-r", region, "-c", command, "--timeout", "30", "-o", "json"], { maxBuffer: 24000000, timeout: 40000 });
      const envelope = JSON.parse(stdout);
      if (envelope.exit_code !== 0) throw new Error("Remote preview failed");
      result = JSON.parse(envelope.stdout ?? envelope.output);
      if (staticAsset && result.status === 200) cache.set(route, result);
    }
    res.writeHead(result.status, { ...result.headers, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : Buffer.from(result.data, "base64"));
  } catch { res.writeHead(503); res.end("Server preview is temporarily unavailable"); }
  finally { release(); }
});
server.listen(8800, "127.0.0.1", () => console.log("FinHot ECS preview: http://127.0.0.1:8800"));
