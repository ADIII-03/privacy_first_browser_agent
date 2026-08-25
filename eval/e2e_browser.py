#!/usr/bin/env python3
"""
e2e_browser.py — Drive the REAL extension in a REAL browser end-to-end over CDP.

This is the "does the actual agent actually work" check that complements the
Node scorecard (eval/run_all.js scores detector cores; this scores the loop):
content script → on-device vision → redaction → POST /plan → validated action
→ fill_local from the local vault → repeat → done, with privacy receipts on
every step.

Prereqs (eval/e2e_run.sh wires all of this up for you):
  * reasoning server on :8000            (cd server && bash run.sh)
  * demo page served on :8088            (python3 -m http.server 8088 -d demo)
  * Chromium with the test-rig extension loaded, CDP on :9222
    (test rig = copy of extension/ with host_permissions <all_urls>, because
     captureVisibleTab needs activeTab granted by a REAL user gesture, which
     automation can't produce — the shipped manifest stays strict)

Env: CDP_PORT, TASK, PROFILE_DIR (Preferences fallback for the extension id
when the MV3 service worker is dormant and absent from /json), OUT_PNG.

Exit 0 = the loop ran to completion (running:false after >=1 step).
"""
import asyncio, glob, json, os, sys, time, urllib.parse, urllib.request

BASE = f"http://localhost:{os.environ.get('CDP_PORT', '9222')}"
TASK = os.environ.get("TASK", "Fill my email and phone from my profile, then submit the application.")
DEMO_URL = os.environ.get("DEMO_URL", "http://localhost:8088/index.html")
PROFILE_DIR = os.environ.get("PROFILE_DIR", "")
OUT_PNG = os.environ.get("OUT_PNG", os.path.join(os.path.dirname(__file__), "out_e2e.png"))


def targets():
    return json.load(urllib.request.urlopen(BASE + "/json", timeout=5))


def new_tab(url):
    q = urllib.parse.quote(url, safe="")
    req = urllib.request.Request(f"{BASE}/json/new?{q}", method="PUT")  # Chrome 111+: PUT
    return json.load(urllib.request.urlopen(req, timeout=5))


async def rpc(ws_url, method, params=None, timeout=20):
    import websockets

    async def _go():
        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
            while True:
                m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if m.get("id") == 1:
                    if "error" in m:
                        raise RuntimeError(json.dumps(m["error"])[:300])
                    return m.get("result", {})

    return await asyncio.wait_for(_go(), timeout)


async def ev(ws_url, expr, timeout=20):
    r = await rpc(ws_url, "Runtime.evaluate",
                  {"expression": expr, "awaitPromise": True, "returnByValue": True}, timeout)
    if r.get("exceptionDetails"):
        ed = r["exceptionDetails"]
        raise RuntimeError(f"EVAL-EXC {ed.get('exception', {}).get('description') or json.dumps(ed)[:500]}")
    return r.get("result", {}).get("value")


async def attach_isolated(demo_target):
    """Bind an evaluator to the content script's ISOLATED world — the only one
    with chrome.runtime. Runtime.enable replays existing contexts as events that
    can arrive BEFORE the enable response, so read both concurrently."""
    import websockets
    ws = await websockets.connect(demo_target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
    await ws.send(json.dumps({"id": 1, "method": "Runtime.enable", "params": {}}))

    iso_ctx, enabled = None, False
    try:
        while not (enabled and iso_ctx):
            m = json.loads(await asyncio.wait_for(ws.recv(), 8))
            if m.get("id") == 1:
                enabled = True
                continue
            c = m.get("params", {}).get("context")
            aux = (c or {}).get("auxData", {})
            if c and (aux.get("type") == "isolated" or aux.get("isDefault") is False):
                iso_ctx = c["id"]
    except asyncio.TimeoutError:
        pass
    if iso_ctx is None:
        raise RuntimeError("no isolated content-script context found (content script not injected?)")

    n = [2]

    async def ev(expr, timeout=15):
        rid = n[0]
        n[0] += 1
        await ws.send(json.dumps({"id": rid, "method": "Runtime.evaluate",
                                  "params": {"expression": expr, "awaitPromise": True,
                                             "returnByValue": True, "contextId": iso_ctx}}))
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if m.get("id") == rid:
                if m.get("error"):
                    raise RuntimeError(json.dumps(m["error"])[:300])
                r = m.get("result", {})
                if r.get("exceptionDetails"):
                    ed = r["exceptionDetails"]
                    raise RuntimeError(f"EVAL-EXC {ed.get('exception', {}).get('description') or json.dumps(ed)[:400]}")
                return r.get("result", {}).get("value")

    return ev


def id_from_profile():
    for f in glob.glob(os.path.join(PROFILE_DIR, "Default", "*Preferences")) if PROFILE_DIR else []:
        try:
            s = json.load(open(f)).get("extensions", {}).get("settings", {})
            for eid, cfg in s.items():
                if "ext-test" in str(cfg.get("path", "")):
                    return eid
        except Exception:
            pass
    return None


async def main() -> int:
    # 1. extension id: live SW target first, then Preferences (MV3 workers go
    #    dormant after ~30s idle and drop off /json)
    ext_id = None
    for _ in range(8):
        for t in targets():
            u = t.get("url", "")
            if "chrome-extension://" in u and u.endswith("/background/service-worker.js"):
                ext_id = u.split("/")[2]
                break
        if ext_id:
            break
        await asyncio.sleep(0.4)
    ext_id = ext_id or id_from_profile()
    if not ext_id:
        print("FATAL: extension id undiscoverable — is the test rig loaded?")
        return 2
    print(f"[e2e] extension: {ext_id}")

    # 2. demo tab (content scripts attach here)
    new_tab(DEMO_URL)
    demo_ws = None
    for _ in range(40):
        await asyncio.sleep(0.4)
        d = [t for t in targets() if t["type"] == "page" and DEMO_URL.split("//")[1].split("/")[0] in t["url"]]
        if d:
            try:
                await ev(d[-1]["webSocketDebuggerUrl"], "document.title", 8)
                demo_ws = d[-1]
                break
            except Exception:
                continue
    if not demo_ws:
        print("FATAL: demo tab never became reachable — is the demo http server up?")
        return 2
    print(f"[e2e] demo tab: {demo_ws['url']}")

    # 3. popup dashboard as a page target (it owns the Run button)
    new_tab(f"chrome-extension://{ext_id}/popup/popup.html")
    pw = None
    for _ in range(30):
        await asyncio.sleep(0.3)
        m = [t for t in targets() if t["type"] == "page"
             and ext_id in t.get("url", "") and "popup.html" in t["url"]]
        if m:
            try:
                await ev(m[-1]["webSocketDebuggerUrl"], "1+1", 6)
                pw = m[-1]
                break
            except Exception:
                continue
    if not pw:
        print("FATAL: popup not reachable")
        return 2
    print("[e2e] popup attached")

    # 4. kick the task (activate demo tab first: the loop perceives the active tab)
    started = await ev(pw["webSocketDebuggerUrl"], f"""(async()=>{{
      const tabs=await chrome.tabs.query({{url:'{DEMO_URL.rsplit("/",1)[0]}/*'}});
      if(!tabs.length) return 'no-demo-tab';
      await chrome.tabs.update(tabs[0].id,{{active:true}});
      document.getElementById('task').value={json.dumps(TASK)};
      document.getElementById('run').click();
      return 'kick tab='+tabs[0].id;
    }})()""", 15)
    print(f"[e2e] {started}")

    # 5. poll state via the demo tab's content-script world
    cev = await attach_isolated(demo_ws)
    last, t0, ok = "", time.time(), False
    while time.time() - t0 < 60:
        await asyncio.sleep(0.5)
        try:
            s = await cev("""(async()=>{try{
              const s=await chrome.runtime.sendMessage({cmd:'GET_STATE'});
              const st=s.state||{};
              return JSON.stringify({running:st.running,step:st.step,
                log:(st.log||[]).map(e=>e.kind+':'+String(e.reasoning||e.error||(e.receipt?('detected='+e.receipt.detected+' redacted='+e.receipt.redacted+' shot='+e.receipt.send_screenshot+' risk='+e.receipt.residual_risk):JSON.stringify(e.action||{}).slice(0,90)))).slice(-10)});
            }catch(e){return JSON.stringify({pollerr:String(e&&e.message||e)})}})()""", 10)
        except Exception as e:
            s = json.dumps({"pollerr": f"ws:{str(e)[:120]}"})
        cur = s if isinstance(s, str) else json.dumps(s)
        if cur != last:
            print(f"[{time.time()-t0:5.1f}s]", cur[:800])
            last = cur
        st = json.loads(s) if s.startswith("{") else {}
        if "pollerr" not in st and st.get("running") is False and st.get("step", 0) > 0:
            ok = True
            break
    print(f"[e2e] loop {'COMPLETED' if ok else 'DID NOT complete'} in {time.time()-t0:.1f}s")

    # 6. visual artifact
    try:
        d2 = [t for t in targets() if t["type"] == "page" and DEMO_URL in t["url"]][-1]
        shot = await rpc(d2["webSocketDebuggerUrl"], "Page.captureScreenshot", {"format": "png"})
        import base64
        open(OUT_PNG, "wb").write(base64.b64decode(shot["data"]))
        print(f"[e2e] screenshot: {OUT_PNG}")
    except Exception as e:
        print(f"[e2e] screenshot skipped: {str(e)[:120]}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
