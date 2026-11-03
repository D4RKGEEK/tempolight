# Security

Tempolight is made for home and venue networks. It has no user accounts; anyone who can reach its port can use the
parts that aren't PIN-locked.

- Don't expose Tempolight's port to the internet. To control it remotely, use a VPN such as Tailscale or WireGuard.
- Set a PIN (Settings → Lock) at parties so guests can't change devices, the room, schedules or settings.
- The PIN is stored as a salted scrypt hash; unlock tokens last 12 hours and are cleared when the PIN changes.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's security advisories](https://github.com/D4RKGEEK/tempolight/security/advisories/new) rather than a public
issue. Include steps to reproduce and the version you used. You'll get a reply within a week.
