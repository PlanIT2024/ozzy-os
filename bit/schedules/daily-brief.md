---
name: daily-brief
cron: "0 8 * * 1-5"
enabled: true
channel: bit
---

Give Ozzy a short, scannable weekday morning brief in bIT's voice:
- Machine health: use list_machines and machine_status; one concise line per machine. Flag offline or concerning resource usage.
- Use list_reminders to show reminders due today in the configured timezone.
- Read bit/memory/profile.md and relevant files in bit/memory for open goals and projects.
- Include anything flagged yesterday in memory. If nothing was recorded, say so briefly; never invent it.
- Mention any missed schedule runs supplied in the run context.
Keep the brief short. Use local memory and machine/reminder tools; no web access is requested.
