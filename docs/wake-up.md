# Wake up, wind down and the ambient plan

The **Home & sleep** page (in the menu) has three things for everyday life, when no music is playing:

- **Wake-up sunrise**: the lights fade up from deep red through orange to warm white over 10–40 minutes, so they
  are at full light when your alarm goes off. You can set a time for each weekday, or link it to your phone's alarm.
- **Sleep timer**: the lights get warmer and dimmer over 15–60 minutes and turn off at the end.
- **Ambient plan**: what the room shows through the day when nothing plays, for example bright and cool in the
  morning, neutral during the day, warm in the evening and night mode at night.

## Wake-up sunrise

Turn **Wake-up sunrise** on and choose:

| Setting | What it does |
| --- | --- |
| Set times / Linked to my phone | Set a time for each weekday (leave a day empty for no alarm), or let your phone start the sunrise (below) |
| Sunrise takes | 10 to 40 minutes. The light is at its end colour and brightness at the alarm time |
| Lights | The whole room, one zone (for example the bedroom) or one controller. With the lights off, the others stay dark |
| End colour, end brightness | Where the sunrise ends: warm white, daylight or any colour |
| Stay on after | How long the end light stays before Tempolight goes back to the usual lights (0 to 120 minutes) |
| Snooze | How long a snooze dims the light to a soft glow before it comes back up |

The sunrise turns the lights on if they are off, and it covers whatever the room was showing, even in night mode and
whatever the brightness slider is set to. The live pads still work over it, so **Blackout** makes the room dark.
Turning the lights off with the power switch stops the sunrise.

**Snooze** dims the light to a glow; after the snooze time it rises back to full in three minutes. **Stop** fades back
to the usual lights within a few seconds. **Skip next wake-up** cancels the next alarm only.

Times are the clock of the computer Tempolight runs on.

## Link it to your phone

A phone automation calls Tempolight's API. You need the address of your Tempolight (for example
`http://192.168.1.20:8080`) and, if you set a PIN lock, the **link key** shown on the Home & sleep page.

| Call | Body (JSON, all optional) | What it does |
| --- | --- | --- |
| `POST /api/wake` | `{"inMinutes": 30}`, `{"at": "07:00"}`, `{"at": "2026-11-05T07:00:00+01:00"}` or `{"at": 1793948400000}`, plus `"duration": 20` | Start a sunrise that is at full light at that time. With no time, the sunrise starts now. If the alarm is sooner than the sunrise's length, it starts now and rises faster |
| `POST /api/wake/snooze` | `{"minutes": 9}` | Snooze the sunrise that is running |
| `POST /api/wake/stop` | | Stop the sunrise that is running |
| `DELETE /api/wake` | | Cancel the next sunrise (or skip the next weekly alarm) |
| `POST /api/sleep` | `{"minutes": 30}` | Start the sleep timer |
| `DELETE /api/sleep` | | Cancel the sleep timer |

A sunrise asked for while another one runs (your phone sends tomorrow's alarm, say) waits until its time and doesn't
cut the running one short.

**Security.** Without a PIN lock anyone on your network can use the API, as with everything else in Tempolight. With
a PIN lock these calls work for guests only if guests may change brightness (Settings → Lock → **Brightness and
power**). Otherwise add the
link key: `…/api/wake?key=<key>`, or a header `x-tempolight-key: <key>`. The key opens only these calls, nothing else,
and **New key** on the Home & sleep page replaces it if it ever leaks. Calls from other websites in a browser are
refused, and Shortcuts, Tasker and Home Assistant aren't affected by that. Set Wake-up sunrise to **Linked to my
phone** so a weekly time doesn't also go off; if Wake-up is turned off, `POST /api/wake` is refused (409).

### iPhone (Shortcuts)

The Shortcuts app can run an automation when an alarm goes off, is snoozed or is stopped. Make one automation for
each:

1. Open **Shortcuts** → **Automation** → **+** (New Automation).
2. Choose **Alarm**, then **Is Stopped**, **Is Snoozed** or **Goes Off**, and **Wake-Up** (your Sleep schedule's alarm)
   or **Existing** to pick one alarm. Choose **Run Immediately** so it doesn't ask you first.
3. Add the action **Get Contents of URL**. URL: `http://192.168.1.20:8080/api/wake/snooze?key=<key>` (or `/stop`,
   or `/api/wake`). Tap **Show More**: Method **POST**, Request Body **JSON** (add fields such as `duration` if you like).
4. Save. Make the same for the other trigger.

iOS starts automations *when* the alarm rings, not before it, so to have the sunrise *finish* at the alarm:

- **Easiest:** use **Set times** in Tempolight with your usual wake-up times, and add only the Snooze and Stop
  automations on the phone.
- **Or a silent alarm before the real one:** make an alarm 30 minutes earlier with **Sound: None** (and Haptics:
  None), and an automation **Alarm → that alarm → Goes Off → Get Contents of URL** `POST /api/wake` with JSON
  `{"inMinutes": 30}`. The sunrise starts then and is at full light when your real alarm rings.
- **Or light with the alarm:** **Alarm → Wake-Up → Goes Off** → `POST /api/wake` with `{"duration": 10}` gives a
  quick ten-minute sunrise starting at the alarm.
- **Or send the alarm time each night:** newer iOS versions have Clock actions in Shortcuts (such as *Get All
  Alarms*/*Find Alarms*) that can read an alarm's time; the names differ between iOS versions. In an automation such
  as **Charger → Is Connected** in the evening, get the time of your enabled wake-up alarm, format it as ISO 8601
  (**Format Date**), and send it as `{"at": "<date>"}`. Tempolight works out when to start.

The phone needs to be on the same network as Tempolight (or reach it through a VPN).

### Android with Home Assistant

The Home Assistant companion app has a **Next alarm** sensor (turn it on in the app: Settings → Companion app →
Manage sensors → Next alarm). It holds the time of your phone's next alarm. Send it to Tempolight whenever it
changes; Tempolight starts the sunrise at the right moment:

```yaml
rest_command:
  tempolight_wake:
    url: "http://192.168.1.20:8080/api/wake?key=<key>"
    method: POST
    content_type: "application/json"
    payload: '{"at": "{{ at }}"}'
  tempolight_wake_stop:
    url: "http://192.168.1.20:8080/api/wake/stop?key=<key>"
    method: POST

automation:
  - alias: "Sunrise before my phone's alarm"
    trigger:
      - platform: state
        entity_id: sensor.my_phone_next_alarm
    condition:
      - condition: template
        value_template: "{{ states('sensor.my_phone_next_alarm') not in ['unavailable', 'unknown'] }}"
    action:
      - service: rest_command.tempolight_wake
        data:
          at: "{{ states('sensor.my_phone_next_alarm') }}"
```

Alarms more than 36 hours away are refused, so Tempolight only plans tomorrow's. Send `DELETE /api/wake` if you
turn the alarm off. With MQTT set up (Settings → Home Assistant), Tempolight also has buttons **Sleep timer**,
**Snooze wake-up** and **Stop wake-up** in Home Assistant.

### Android with Tasker

1. Make a task with the **Test Next Alarm** action (it puts the next alarm's time, in milliseconds, into `%na_time_ms`).
   If Tasker finds no alarm, set Tasker's preference *Use Reliable Alarms* to *Never* (Tasker's own timers can hide
   your clock's alarm).
2. **Net → HTTP Request**: Method **POST**, URL `http://192.168.1.20:8080/api/wake?key=<key>`, Body
   `{"at": %na_time_ms}`, Headers `Content-Type:application/json`. Put it inside **If** `%na_time_ms Set`.
3. Run the task from a profile, for example **Time** every evening at 22:00, or when the phone starts charging.

For Snooze and Stop, many clock apps send intents Tasker can react to (or use the Home Assistant companion app);
point those at `/api/wake/snooze` and `/api/wake/stop`.

## Sleep timer

**Sleep in 30 min** on the Home page (or on Home & sleep, with 15, 30, 45 or 60 minutes) starts it. Over that time
the colours turn warm and the light dims to off; then the lights switch off. Your brightness setting isn't changed,
so the lights come back normally next time. Changing the brightness or switching the lights off or on cancels it;
so does a starting sunrise. From Home Assistant: the **Sleep timer** button, or `POST /api/sleep`.

## Ambient plan

A table of rows, each with from–until times (they may cross midnight, and can be `sunset` or `sunrise+30` once your
location is set), a look, colours, a colour temperature and a brightness:

| Look | What it shows |
| --- | --- |
| Soft white | Plain light at the colour temperature you choose (2200 K candle to 6500 K daylight) |
| An effect | That calm effect, in the colours you choose; with a colour temperature, its movement in that white |
| Night mode | A dim, warm candle light. The row also turns night mode on: brightness cap, warm colours, no strobes |

When the hour changes, the look and the brightness crossfade (90 seconds by default), and so do the edits you save.
Hours not in the table use the usual ambient effect from Settings. The plan only changes what shows when nothing
plays (and the soft floor in quiet passages); the brightness of a row replaces *Idle brightness*.

**With night mode.** Night mode's own hours (Settings → Night mode) always win: inside them the plan shows its night
look, capped at night mode's brightness. A **Night mode** row turns night mode on by itself during its hours, so you
can use the plan instead of night mode's hours. A sunrise is brighter than night mode allows on purpose.

The plan is off until you turn it on; the suggested table is filled in for you.
