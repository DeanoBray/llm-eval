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
via Teams or email. He'll add it to Mímir's `authorized_keys`.

## Step 3 — Open the tunnel to Mímir's oMLX

Mímir's oMLX listens on port **21434** on Mímir. Tunnel it to a local port
on your machine (use 21434 for convenience, or pick a free local port):

```bash
ssh -N -L 21434:127.0.0.1:21434 sje@mimir.local
```

- `-N` — don't run a remote command (tunnel only)
- `-L 21434:127.0.0.1:21434` — forward local `localhost:21434` → Mímir `127.0.0.1:21434`
- Keep this terminal open while you're working; Ctrl-C closes the tunnel.

Leave it running in the background if you prefer:

```bash
ssh -f -N -L 21434:127.0.0.1:21434 sje@mimir.local
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
| `ssh: Could not resolve hostname mimir.local` | You're not on the home LAN. Ask Scott for the right host, or confirm you're on the VPN. |
| `Permission denied (publickey)` | Your public key isn't on Mímir yet. Re-check Step 2. |
| `Connection refused` on 21434 | The tunnel isn't up, or oMLX isn't running. Confirm the `ssh` terminal is still open. |
| Port 21434 already in use locally | Use a different local port, e.g. `-L 21435:127.0.0.1:21434`, and set `OMLX_URL=http://localhost:21435`. |
