# SSH Access to Mímir (oMLX)

Mímir is the team's Mac Studio that runs the local oMLX model gateway
(OpenAI-compatible `/v1/chat/completions`). If your script needs to reach
a local model on Mímir (fact extraction, ground-truth matching, classification,
scoring, or the judge) during development, you'll connect through an SSH tunnel
to Mímir.

> **Note:** This access is for the **local models on Mímir** used *downstream*
> of the scenario responses — fact extraction, ground-truth matching,
> classification, scoring, and the judge. The scenario responses themselves
> are **non-local** (Sonnet 5 for US, DeepSeek V4 Pro for CN, both via API).
> The full 1,200-run is executed once by Scott (LLMEV-101); you only need the
> tunnel to iterate on your local-model stage during development.

## The `llm-eval` account

Everyone connects to a dedicated, **isolated** `llm-eval` account on Mímir,
not the `sje` admin account. It's a shared, **non-admin** account used by the
whole team (and by Scott) so no one's work touches the admin account.

- **Key-only** — password authentication is disabled; each member uses their
  own SSH key.
- Keys are added by Scott to `/Users/llm-eval/.ssh/authorized_keys`.
- You reach Mímir through `lex.scomatic.com` on the external **port 2122**
  (which forwards to Mímir's SSH on port 22), so it works from anywhere with
  internet access — no need to be on the home LAN/VPN.

## Step 1 — Generate an SSH key

If you don't already have one, generate an ed25519 key on your machine:

```bash
ssh-keygen -t ed25519 -C "yourname@latrobe.edu.au" -f ~/.ssh/id_ed25519
```

Press Enter to accept the default location (leave the passphrase blank, or
set one if you prefer — if you set a passphrase you'll need `ssh-agent`).

## Step 2 — Send Scott your public key

Copy the **public** key (`.pub` file, not the private key):

```bash
cat ~/.ssh/id_ed25519.pub
```

Send the full output (the line starting with `ssh-ed25519 ...`) to Scott
via Teams or email. He'll add it to the `llm-eval` account's `authorized_keys`.

## Step 3 — Connect & open the tunnel to Mímir's oMLX

Quick check that you can log in (your key must already be added):

```bash
ssh -p 2122 llm-eval@lex.scomatic.com
```

Mímir's oMLX gateway is reachable on Mímir at `127.0.0.1:21434`.
Tunnel it to a local port on your machine (use 21434 locally for convenience,
or pick any free local port):

```bash
ssh -N -L 21434:127.0.0.1:21434 llm-eval@lex.scomatic.com -p 2122
```

- `-N` — don't run a remote command (tunnel only)
- `-L 21434:127.0.0.1:21434` — forward local `localhost:21434` → Mímir `127.0.0.1:21434`
- `-p 2122` — use the external SSH port on `lex.scomatic.com`
- Keep this terminal open while you're working; Ctrl-C closes the tunnel.

Leave it running in the background if you prefer:

```bash
ssh -f -N -L 21434:127.0.0.1:21434 llm-eval@lex.scomatic.com -p 2122
```

## Step 4 — Point your script at the tunnel

Once the tunnel is up, the local model endpoint is available at:

```
http://localhost:21434
```

Set it in your config / `.env`:

```
OMLX_URL=http://localhost:21434
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ssh: Could not resolve hostname lex.scomatic.com` | Offline or DNS is down. The host resolves to Mímir's public IP (58.168.253.35). |
| `Permission denied (publickey)` | Your public key isn't on the `llm-eval` account yet. Re-check Step 2, or ask Scott to add your key. |
| `Connection closed by ... port 22` (with a valid key) | The `llm-eval` account isn't in the `com.apple.access_ssh` group. Flag it to Scott/lex. |
| `Connection refused` on 21434 | The tunnel isn't up, or oMLX isn't running. Confirm the `ssh` terminal is still open. |
| Port 21434 already in use locally | Use a different local port, e.g. `-L 21435:127.0.0.1:21434`, and set `OMLX_URL=http://localhost:21435`. |
