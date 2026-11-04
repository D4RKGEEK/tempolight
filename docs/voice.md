# Voice control

Say "Hey Google, activate Party mode" or "Alexa, turn on Chill mode" and the room changes. Tempolight has no voice
assistant of its own: it goes through **Home Assistant**, which already talks to Google Assistant and Alexa. If you
don't use Home Assistant, see [Without Home Assistant](#without-home-assistant) at the end.

```
 "Hey Google, activate Party mode"
        │
 Google Assistant / Alexa ──► Home Assistant (Cloud, or your own setup) ──► MQTT broker ──► Tempolight
```

## What Home Assistant gets

Once Tempolight is connected to Home Assistant (step 1), it appears by itself, with:

| In Home Assistant | Entity | Say |
| --- | --- | --- |
| One **scene** per Tempolight scene | `scene.party_mode`, `scene.chill_mode`, `scene.movie_mode`, `scene.focus_mode`, `scene.relax` | "Hey Google, activate Party mode" · "Alexa, turn on Movie mode" |
| A scene that turns the lights off | `scene.tempolight_off` | "Hey Google, activate Tempolight off" |
| The **light** (on/off, brightness, effect) | `light.tempolight_lights` | "Hey Google, turn off Tempolight Lights" · "Alexa, set Tempolight Lights to 40 percent" |
| A scene picker, tempo / song part / music source sensors, Flash / Drop now / Next effect buttons | `select.tempolight_scene`, `sensor.tempolight_tempo`, `button.tempolight_flash`, … | (for automations and dashboards) |

Every scene you save in Tempolight (Scenes page, or **Save as scene** on Home) becomes a scene in Home Assistant a
moment later, under the same name; a scene you delete disappears from Home Assistant too. The scene entities are
deliberately not grouped under the Tempolight device, so their name is just the scene's name ("Party mode", not
"Tempolight Party mode"), which is what you say to the assistant.

**Names for voice.** Short, distinct names work best: "Party mode", "Chill mode", "Movie mode", "Relax". New
installs start with these scenes. If you installed Tempolight before they existed, your scenes are called "Party",
"Chill evening", "Movie night" and "Focus": rename them on the Scenes page (or add a voice alias in Home Assistant,
see below). Avoid names that clash with other things in your home, like "Lights off" or "Movie" when you already have
a Hue scene with that name.

## 1. Connect Tempolight to Home Assistant

1. In Home Assistant, install the **Mosquitto broker** add-on (Settings → Add-ons → Add-on store), start it, and add
   the **MQTT** integration when Home Assistant offers it (Settings → Devices & services).
2. Create a Home Assistant user for Tempolight (Settings → People → Users, e.g. `tempolight`), or use any user: the
   Mosquitto add-on accepts Home Assistant users.
3. In Tempolight, open **Settings → Home Assistant**, tick **Connect**, enter the broker
   (`mqtt://homeassistant.local:1883`, or the IP address of your Home Assistant) and the user name and password, then
   **Save**. The panel says *Connected*.
4. In Home Assistant, Settings → Devices & services → MQTT now lists a **Tempolight** device, and the scenes are
   under Settings → Entities (search "scene.").

Or with the API: `PATCH /api/settings {"mqtt": {"enabled": true, "url": "mqtt://homeassistant.local:1883", "username": "tempolight", "password": "…"}}`.

## 2a. Google Assistant

### With Home Assistant Cloud (Nabu Casa): the easy way

1. Home Assistant → Settings → **Home Assistant Cloud**: sign in, and turn on **Google Assistant**.
2. Settings → **Voice assistants** → **Expose** tab: expose the Tempolight scenes (`scene.party_mode`, …) and
   `light.tempolight_lights`. Uncheck "expose new entities" if you don't want everything else too.
3. Optional: click an entity there to give it **aliases** ("Party", "Disco") or a different name for Google.
4. In the **Google Home** app on your phone: **+** → Set up device → **Works with Google** → search
   **Home Assistant Cloud by Nabu Casa** → sign in with your Home Assistant account.
5. Say "Hey Google, sync my devices" after adding or renaming scenes later.

Then: "Hey Google, activate Party mode", "Hey Google, turn on Chill mode", "Hey Google, dim Tempolight Lights to
30 percent".

### Without Nabu Casa

Home Assistant's own `google_assistant` integration works without the subscription, but you have to create a
project in the Google Home Developer Console, a service account, and make Home Assistant reachable over HTTPS from
the internet. Follow <https://www.home-assistant.io/integrations/google_assistant/>, then expose Tempolight in
`configuration.yaml`:

```yaml
google_assistant:
  project_id: your-project-id
  service_account: !include SERVICE_ACCOUNT.JSON
  report_state: true
  expose_by_default: false
  entity_config:
    scene.party_mode:
      expose: true
    scene.chill_mode:
      expose: true
    scene.movie_mode:
      expose: true
    scene.relax:
      expose: true
    light.tempolight_lights:
      expose: true
      name: Tempolight
      aliases: [Music lights, LED strip]
```

## 2b. Alexa

### With Home Assistant Cloud (Nabu Casa)

1. Home Assistant → Settings → **Home Assistant Cloud**: turn on **Alexa**.
2. Settings → Voice assistants → **Expose** tab: expose the Tempolight scenes and light (same as for Google).
3. In the **Alexa** app: More → Skills & Games → search **Home Assistant** → Enable, sign in with your Home Assistant
   account, then **Discover devices**.

Alexa activates scenes with "turn on": "Alexa, turn on Party mode", "Alexa, turn on Tempolight off", "Alexa, turn off
Tempolight Lights". You can also put a Tempolight scene in an **Alexa Routine** (Routines → + → When "Alexa, party
time" → Add action → Smart Home → Scenes → Party mode).

### Without Nabu Casa

Home Assistant's `alexa` smart home integration needs an AWS Lambda function and Home Assistant reachable over
HTTPS: <https://www.home-assistant.io/integrations/alexa.smart_home/>. Then:

```yaml
alexa:
  smart_home:
    filter:
      include_entities:
        - scene.party_mode
        - scene.chill_mode
        - scene.movie_mode
        - scene.relax
        - light.tempolight_lights
    entity_config:
      light.tempolight_lights:
        name: Tempolight
```

## Scripts and automations

The scenes are ordinary Home Assistant scenes, so they work in scripts, automations, dashboards and with Assist
(Home Assistant's own voice assistant: "activate Party mode" works there too once the scenes are exposed).

```yaml
# scripts.yaml: one phrase, several things ("Hey Google, activate Party time" once the script is exposed)
party_time:
  alias: Party time
  sequence:
    - action: scene.turn_on
      target:
        entity_id: scene.party_mode
    - action: light.turn_on
      target:
        entity_id: light.tempolight_lights
      data:
        brightness_pct: 100
    - action: button.press        # a flash to say "go"
      target:
        entity_id: button.tempolight_flash
```

```yaml
# automations.yaml
- alias: Tempolight follows the TV
  triggers:
    - trigger: state
      entity_id: media_player.living_room_tv
      to: "playing"
  actions:
    - action: scene.turn_on
      target:
        entity_id: scene.movie_mode

- alias: Chill mode at sunset
  triggers:
    - trigger: sun
      event: sunset
  actions:
    - action: scene.turn_on
      target:
        entity_id: scene.chill_mode

- alias: Tempolight off at midnight
  triggers:
    - trigger: time
      at: "00:00:00"
  actions:
    - action: light.turn_off
      target:
        entity_id: light.tempolight_lights

- alias: Flash the lights when the doorbell rings
  triggers:
    - trigger: state
      entity_id: binary_sensor.doorbell
      to: "on"
  actions:
    - action: mqtt.publish
      data:
        topic: tempolight/action/set
        payload: flash
```

Any Tempolight scene can also be applied by name over MQTT, without a scene entity:

```yaml
- action: mqtt.publish
  data:
    topic: tempolight/scene/set
    payload: Party mode        # a scene name or id
```

(`tempolight` is the MQTT base topic, Settings → Home Assistant; `homeassistant` is the discovery prefix.)

## Without Home Assistant

Everything above goes through Tempolight's HTTP API, which anything on your network can call: Siri Shortcuts, a
Stream Deck, Node-RED, a script.

```sh
curl -X POST http://tempolight.local:8080/api/scenes/party/apply          # a scene, by id (GET /api/scenes lists them)
curl -X POST http://tempolight.local:8080/api/power -H 'content-type: application/json' -d '{"on": false}'
curl -X POST http://tempolight.local:8080/api/brightness -H 'content-type: application/json' -d '{"value": 0.4}'
```

When Tempolight is locked with a PIN, scenes, power and brightness still work if guests are allowed to use them
(Settings → Lock); otherwise send the `x-tempolight-token` header from `POST /api/unlock`.

- **"Hey Siri"**: in the Shortcuts app, make a shortcut called "Party mode" with one action, **Get contents of URL**:
  `http://<tempolight address>:8080/api/scenes/party/apply`, method **POST**. Saying the shortcut's name runs it
  (your phone must be on the home Wi-Fi, or use a VPN).
- **Home Assistant without MQTT**: the `rest_command` in [api.md](api.md#home-assistant-without-mqtt), then a
  script that calls it, exposed to Google or Alexa like the scenes above.

Google Assistant and Alexa can't reach a device on your home network by themselves; they always need a bridge such as
Home Assistant Cloud.

## Troubleshooting

- **The scenes don't show up in Home Assistant.** Settings → Home Assistant in Tempolight must say *Connected*;
  Home Assistant's MQTT integration must use the same broker, with discovery on (the default, prefix
  `homeassistant`).
- **Google or Alexa doesn't know the new scene.** Expose it (Settings → Voice assistants → Expose), then "Hey
  Google, sync my devices" or "Alexa, discover devices".
- **The assistant picks something else.** Rename the scene in Tempolight to something more distinct, or give it an
  alias in Home Assistant's Expose page.
- **"Activate Party mode" does nothing.** Look at Tempolight's Activity log on Home: every scene applied says
  `Scene: Party mode`. If it isn't there, the command didn't arrive; check Home Assistant's logbook for the scene.
