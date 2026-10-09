# Deploy runbook — PVE Signal Engine (Phases 0–4) + capture timer

**All commands below run on the VPS shell** — the prompt that looks like `root@vultr:~#`.
The only step on your **Windows PowerShell** (`PS C:\Users\ASUS>`) is the upload in step 0.
Your dashboard password and `OPTIONS_API_KEY` already live in `/opt/pve-signal-engine/.env` — this deploy **preserves** that file and the accumulated `research-data/`.

---

## 0. (Windows PowerShell) upload the zip to the VPS
```powershell
scp pve-signal-engine.zip root@96.30.207.251:/root/
```

## 1. (VPS) unpack to a staging dir
```bash
cd /root
rm -rf pve-stage && mkdir pve-stage
unzip -q pve-signal-engine.zip -d pve-stage
ls pve-stage        # should list server.js, research/, validated/, deploy/, public/ …
```

## 2. (VPS) deploy into the live app dir — PRESERVING .env and research-data
```bash
rsync -a --delete \
  --exclude='.env' --exclude='research-data/' --exclude='node_modules/' --exclude='ai-runs/' --exclude='.git/' \
  pve-stage/ /opt/pve-signal-engine/
```

## 3. (VPS) install deps + run the full test suite
```bash
cd /opt/pve-signal-engine
npm ci
npm test            # expect: # pass 163  # fail 0
```
If any test fails, **stop** and do not restart the service — tell me the output.

## 4. (VPS) restart the app
```bash
sudo systemctl restart pve
sudo systemctl status pve --no-pager | head -6
```

## 5. (VPS) verify the app + the new Phase 4 endpoints
```bash
# static asset served → HTTP 200
curl -sI http://127.0.0.1:4000/options-engine.js | head -1

# log in (use YOUR real dashboard password) → cookie jar
curl -s -c /tmp/pve.cookies -X POST http://127.0.0.1:4000/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"SatyajitDD7"}' >/dev/null

# monitor should show validatedModelVersion + validated.primary=current + promotedFeatures=0
curl -s -b /tmp/pve.cookies http://127.0.0.1:4000/api/_monitor | head -c 500; echo

# validated score runs alongside current (delta 0 until features are promoted)
curl -s -b /tmp/pve.cookies http://127.0.0.1:4000/api/validated/AAPL | head -c 400; echo

# shadow + cross-section still work
curl -s -b /tmp/pve.cookies http://127.0.0.1:4000/api/shadow/cross-section | head -c 300; echo
```
Expected: `validated.primary` = `current`, `promotedFeatures` = 0, and `/api/validated/AAPL` shows `current` == `validatedScore` with `delta` 0.

## 6. (VPS) install the capture timer (feeds the Phase 3 dataset)
```bash
cd /opt/pve-signal-engine
sudo cp deploy/pve-capture.service /etc/systemd/system/pve-capture.service
sudo cp deploy/pve-capture.timer   /etc/systemd/system/pve-capture.timer
sudo systemctl daemon-reload
sudo systemctl enable --now pve-capture.timer
```

## 7. (VPS) run one capture immediately + verify
```bash
sudo systemctl start pve-capture.service            # run once now (don't wait for the schedule)
journalctl -u pve-capture.service --no-pager -n 25  # look for "captured N/N signal records → …"
ls -la /opt/pve-signal-engine/research-data/signals/
systemctl list-timers pve-capture.timer --no-pager  # shows next scheduled runs
```
You should see a `signals-YYYY-MM-DD.jsonl` file and a row per ticker.

### If capture logs `node: not found`
Your Node isn't on systemd's default PATH (common with nvm). Find it and pin it:
```bash
which node                                           # e.g. /root/.nvm/versions/node/v22.4.0/bin/node
sudo systemctl edit pve-capture.service              # add, then save:
#   [Service]
#   Environment=PATH=/root/.nvm/versions/node/v22.4.0/bin:/usr/bin:/bin
sudo systemctl daemon-reload && sudo systemctl start pve-capture.service
```

---

## What the timer does
`pve-capture.timer` fires `pve-capture.service` three times each weekday (market open / midday / just-before-close, in US market time). Each run appends one feature row per ticker to `research-data/signals/` (and raw scalars to `research-data/snapshots/`). Nothing touches the live score. Over a few weeks this builds the out-of-sample dataset.

## When enough data has accumulated (later, manual)
```bash
cd /opt/pve-signal-engine
node research/run-phase3.js
less research-data/reports/PHASE3_REPORT.md
```
`run-phase3.js` validates the data and, **only if** features show stable out-of-sample edge, rewrites `validated/promotion.json` with approved features + evidence-derived weights. The validated score then diverges from current in the dashboard. Promotion to **primary** is a separate, deliberate edit (`"primary": "validated"` in `promotion.json`, then `systemctl restart pve`) — nothing does that automatically.

## Managing the timer
```bash
systemctl list-timers pve-capture.timer     # next run
journalctl -u pve-capture.service -n 50     # recent capture logs
sudo systemctl disable --now pve-capture.timer   # stop capturing
```

## Rollback (if needed)
Keep the previous zip. To roll back: re-run steps 1–4 with the older zip (`.env` and `research-data/` are preserved either way).
