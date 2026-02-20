/**
 * Direct JSON-RPC via undici Pool — bypasses ethers so all callers share
 * a single HTTP/2-capable connection pool (keep-alive, multiplexing).
 */
import { Pool } from "undici";

let _pool: Pool | null = null;
let _poolPath = "/";
let _rpcId = 0;

export async function rpcSendRawTx(
  rpcUrl: string,
  signedTx: string
): Promise<any> {
  if (!_pool) {
    const url = new URL(rpcUrl);
    _pool = new Pool(url.origin, {
      allowH2: true,
      connections: 256,
      pipelining: 1,
    });
    _poolPath = url.pathname || "/";
  }

  const { statusCode, body } = await _pool.request({
    method: "POST",
    path: _poolPath,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_sendRawTransaction",
      params: [signedTx],
      id: ++_rpcId,
    }),
  });

  const text = await body.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `RPC returned non-JSON (HTTP ${statusCode}): ${text.slice(0, 200)}`
    );
  }
  if (json.error) {
    const msg = json.error.message || JSON.stringify(json.error);
    throw new Error(msg);
  }
  return json.result;
}
