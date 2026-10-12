# RPF Dashboard

RPF Thana/Post dashboard for IPVSS. A separate application from CMS and M-NVR that **shares the CMS database** and owns no schema: no migrations, no tables, no DDL. CMS stays exactly as it is; RPF reads and writes CMS's own tables.

## How it fits

```
M-NVR ──> CMS ──(alert_delivery + incident rows)──> RPF dashboard ──> officer
                 <──(video_request rows)──────────  RPF
   CMS operator approves, CMS ingest writes delivered_footage ──> RPF serves it
```

RPF and CMS talk only through the shared tables. There is no RPF-to-CMS HTTP call.

| Step | Who | What happens in the database |
|---|---|---|
| Alert arrives | CMS | `alert` -> `alert_delivery` (+ `incident` if auto-dispatched). RPF inbox = deliveries for the officer's post. |
| Acknowledge | RPF | `alert_delivery.ack_at/ack_by`, `alert.status='acknowledged'`, `alert_history` row |
| Raise / work incident | RPF | `incident` insert; status `open -> under_review -> closed` (forward only). Closing resolves the alert. |
| Request footage | RPF | `video_request` insert (status `submitted`) |
| Approve / amend / reject | **CMS operator** | updates `video_request` |
| Deliver footage | **CMS ingest** | inserts `delivered_footage` (one stitched file), sets request `fulfilled` |
| View / save locally | RPF | short-lived `video_access_grant`, served with HTTP Range; every view/download written to `audit_log` |
| Flag for retention | RPF | `evidence_flag` insert; justification mandatory |

## Roles

| CMS role | In RPF |
|---|---|
| `post_user` | Officer: own post only; can acknowledge, raise/close incidents, request, cancel, view, download, flag |
| `zone_admin` | Read-only across every post in their zone, plus posts overview and audit trail |
| `super_admin` | Read-only across all zones |
| `operator` | Not allowed (they use the CMS console) |

Out-of-scope records return 404, not 403, so other posts' ids are not confirmed to exist.

## Run everything with one command

`scripts/start.sh` brings up the whole stack: PostgreSQL, the CMS database, the CMS backend, and the RPF server (API + dashboard).

```
workspace/
  CMS/      your CMS code (unchanged)
  rpf/      this project
```

```bash
cd rpf
bash scripts/start.sh --demo     # first run, with demo data (dev only)
bash scripts/start.sh            # normal start, no demo data
```

On the first run it creates `.env` with random secrets, starts PostgreSQL if it is down, creates the role and database, enables PostGIS, applies the CMS schema and seed, makes sure this month's and the next three months' `alert` / `gps_point` partitions exist, installs dependencies, then starts the services and waits until each answers. Every step is skipped when already done, so it is safe to re-run.

| Command | What it does |
|---|---|
| `start` (default) | Everything above, in the background. Services keep running after the script returns. |
| `run` (or `start -f`) | Same, but stays in the foreground: watches the services, restarts any that crash, streams the logs, and stops everything on Ctrl-C. |
| `stop` | Stops the supervisor (if any), CMS backend, RPF and the demo stand-in. Never stops PostgreSQL. |
| `restart` | `stop`, then `start` |
| `status` | PostgreSQL, supervisor, CMS backend, RPF and stand-in: running or not, and whether they answer |
| `logs [cms\|rpf\|sim]` | Follow the logs in `logs/` |
| `users ...` | List, add and reset RPF logins (see "Logging in") |
| `service-file` | Print a systemd unit that runs the stack at boot (see "Keeping it running") |
| `setup-db` | Only prepare the database |
| `check` | Read-only check that the database suits RPF |

| Flag | Meaning |
|---|---|
| `--demo` | Also load demo zones, posts, NVR units and logins, raise four demo alerts through the CMS backend, and run `simulate_cms.js watch` as a stand-in for the CMS operator and footage ingest. Dev only. |
| `--no-db` | Do not touch the database (it is already prepared) |
| `-f`, `--foreground` | Same as the `run` command |

Demo logins (password `rpf-demo-123`): `post-a-officer`, `post-b-officer`, `zone1-admin`. Dashboard: `http://localhost:7090`. CMS API: `http://localhost:7080`.

Settings live in `.env` (see `.env.example`):

| Variable | Purpose |
|---|---|
| `CMS_DIR` | Where the CMS code is (default `../CMS`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | The one shared database |
| `PORT`, `CMS_PORT` | RPF and CMS backend ports (7090 / 7080) |
| `PRIORITY_THRESHOLD` | CMS auto-dispatches alerts at or above this priority |
| `PG_SUPERUSER`, `PG_SUPERUSER_PASSWORD` | Only for first-time role/database creation when sudo/su access to `postgres` is not available |
| `RPF_LEAST_PRIVILEGE=1` | Run RPF as the least-privilege `rpf_app` role (see below) |
| `ENSURE_PARTITIONS`, `PARTITION_MONTHS_AHEAD` | Monthly partition maintenance at start-up (on, 3 months) |

### Logging in

1. Open the dashboard: `http://localhost:7090` (from another machine on the network: `http://<this-machine-ip>:7090`).
2. Sign in with an RPF account. The start-up banner lists the accounts in the database:

| Account | Role | Sees |
|---|---|---|
| `post-a-officer`, `post-b-officer` | `post_user` | Only their own post. Can acknowledge, work incidents, request, view, download and flag footage. |
| `zone1-admin` | `zone_admin` | Every post in Zone 1, read-only, plus the posts overview and audit trail. |

Accounts created by `--demo` use the password `rpf-demo-123`. **Passwords are stored as bcrypt hashes, so nobody (including this script) can display them.** An account that already existed before `--demo` keeps its old password. Change the demo passwords before anyone else can reach the machine.

CMS operators cannot sign in to the dashboard (they use the CMS console). The CMS `admin` account is a `super_admin` and can sign in if you set a password for it.

### Managing accounts

```bash
bash scripts/start.sh users list
bash scripts/start.sh users password post-a-officer              # generates a password and shows it once
bash scripts/start.sh users password post-a-officer 'MyPass-2026'  # or set one yourself (8+ characters)
bash scripts/start.sh users add sharma post_user "Post B"        # officer for a post (name or id)
bash scripts/start.sh users add boss zone_admin "Zone 1" 'S3cret-Pass'
bash scripts/start.sh users add hq super_admin
```

The commands write to the CMS `users` table with the owner credentials from `.env`, and leave a `user.create` / `user.password` entry in the audit log.

### Keeping it running

- **After the script returns:** `start` already leaves everything running in the background (`bash scripts/start.sh status` shows it). It survives closing the terminal, but not a reboot or a crash.
- **Stay attached, auto-restart on crash:** `bash scripts/start.sh run`. A crashed service is restarted within a few seconds; a service that cannot start (for example its port is taken) is retried and then backed off for 30 s instead of looping. Closing the terminal does not stop it; Ctrl-C or `stop` does.
- **Across reboots:** install it as a systemd service.

```bash
bash scripts/start.sh service-file > rpf-stack.service        # add --demo only for demos
sudo cp rpf-stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rpf-stack
journalctl -u rpf-stack -f                                    # follow the logs
```

The unit runs as your user, waits for PostgreSQL, and handles folder names containing spaces or parentheses. Under systemd the script cannot ask for a `sudo` password, so PostgreSQL must start on its own (it normally does).

Notes on how it behaves:

- **CMS is never modified.** Its own `.env` files are not used; the launcher passes the database settings to the CMS backend as environment variables.
- **Existing database:** if the role and database already exist and the `.env` credentials work, no superuser access is needed at all.
- **Ports:** both are checked before anything starts, so a conflict never leaves a half-started stack.
- **Production:** do not use `--demo`. Put TLS in front, and note that the CMS API has no authentication yet.
- **Partitions** are created with `CREATE TABLE IF NOT EXISTS ... PARTITION OF` as the database owner. Set `ENSURE_PARTITIONS=0` if you manage them yourself.
- **`rpf_app` is cluster-wide.** With `RPF_LEAST_PRIVILEGE=1` the launcher creates the role from `sql/rpf_app_role.sql` and, if it already exists with a different password, resets it to `RPF_APP_PASSWORD` from `.env`. Two RPF deployments on one PostgreSQL cluster would share that role.
- **Needs:** bash, Node.js 18+, `psql`, `curl`, PostgreSQL with PostGIS. Linux is tested. On macOS, `setsid` is absent and the script falls back to plain `nohup`.

### Manual setup (without start.sh)

```bash
cp .env.example .env              # point DB_* at the CMS database, set JWT_SECRET
npm install
npm run check-db                  # read-only: verifies CMS tables, columns and privileges
npm start                         # RPF only, http://localhost:7090 (CMS backend started separately)
```

**Least-privilege role by hand.** Run once as a superuser:

```bash
psql -d cms -v rpf_password='...' -f sql/rpf_app_role.sql
```

`rpf_app` gets SELECT, a few INSERTs, and column-limited UPDATEs. It has no DELETE anywhere and no UPDATE on `audit_log` or `delivered_footage`.

**Footage files.** `delivered_footage.storage_path` is resolved under `MEDIA_ROOT` (mount or sync CMS's footage store there). Paths that escape it are refused.

**Real-time.** The browser polls `/api/alerts/summary` every `ALERT_POLL_SECONDS`, matching the poll-based model in CMS. Swap in SSE later if CMS adds LISTEN/NOTIFY.

## Demo pieces by hand (what `--demo` automates)

```bash
node scripts/seed_demo.js                    # demo logins in users (needs CMS sql/fixtures.sql)
bash <CMS>/scripts/seed_demo_data.sh         # alerts, via CMS's own backend
node scripts/simulate_cms.js watch           # stands in for the operator + ingest
```

Logins: `post-a-officer`, `post-b-officer`, `zone1-admin`, password `rpf-demo-123`. Demo scripts refuse to run with `NODE_ENV=production`.

## The dashboard (frontend)

Served by the same Node process from `public/` (plain HTML, CSS and JavaScript: no build step, no framework, no CDN). Open `http://localhost:7090`.

| Tab | Officer (`post_user`) | Zone / super admin |
|---|---|---|
| Alerts | Inbox with live unacknowledged counter; drawer to acknowledge, raise and work incidents, request footage | Same inbox across posts, read-only, filter by post |
| Requests | Raise, track and cancel footage requests | Read-only |
| Footage | Play in browser, save the original file, flag for retention | Play and save (logged) |
| Evidence flags | Retention flags with justification | Read-only |
| Posts overview | - | One card per post: unacknowledged alerts and how long the oldest has waited, open incidents and requests, active flags |
| Audit trail | - | Every sign-in, acknowledgement, view, download and flag |

The page polls every `ALERT_POLL_SECONDS` and shows a toast when CMS delivers an alert or footage. Browsers play H.264 MP4 natively (Chrome, Edge, Safari, Firefox). If a browser cannot decode a file, the player says so and points to "Save locally". AVI and MKV are download-only.

## Tests

Two layers, both against a real CMS database:

- `npm test` - API workflow test (described below).
- `python3 test/browser/e2e.py` and `python3 test/browser/fallback.py` - drive the real dashboard in headless Chromium (Playwright): sign-in, acknowledge, request, live toast when CMS delivers footage, real video decoding and seeking, download hash check, flagging, admin views, phone layout, console errors, and screenshots into `test/browser/shots/`. Needs `pip install playwright`, `python -m playwright install chromium`, and ffmpeg. Stock Chromium has no H.264, so the e2e script delivers a VP9 clip via `SAMPLE_FILE`, and `fallback.py` checks that an undecodable file gives a clear message.

`RPF_TEST=1 JWT_SECRET=<32+ chars> DB_USER=rpf_app DB_PASSWORD=... TEST_OWNER_USER=cms TEST_OWNER_PASSWORD=... npm test`

Runs the whole workflow through HTTP against a real CMS database as `rpf_app`. Dev databases only: the audit log and delivered footage are append-only, so its rows cannot be cleaned up.

## Things you should know

1. **CMS's dummy alert endpoint sets no `camera_id`.** Incident-driven requests then ask the officer to pick a camera. Real NVR alerts should carry one.
2. **Approval, fulfilment, escalation timers and the 30-day retention job are CMS's.** RPF writes the acknowledgement that stops escalation, and flags that CMS's retention job must honour; neither job exists in CMS yet.
3. **Design-doc items not built:** email/SMS notification (Cl. 3.15.8; needs a provider), watermark/speed overlay (comes from the CMS-stitched file), cross-zone merged requests (CMS resolves those), and the REST contract to a separate CMS (superseded by the shared database you asked for).
4. **Schema gaps in CMS that shaped RPF:** `request_status` has no PENDING/IN_TRANSIT/EXPIRED, so RPF shows CMS's own states; `delivered_footage` has no 'archive status'; `incident` has no manual-raise path without an alert. Worth a CMS schema review.
5. **Security:** the token lives in `sessionStorage`; put TLS in front (RDSO mTLS over IP-MPLS) and keep `JWT_SECRET` out of source control.
