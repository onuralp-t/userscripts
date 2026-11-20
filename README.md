# userscripts
Violentmonkey userscripts.
## Youtube Audio Only
Save bandwidth and compute by disabling visual display of Youtube videos (for the most part).
  - We still accept download stream in 144p for technical reasons but don't draw them on the screen.
## Timestamp in URL
Don't forget where you left off by serializing where you are into the URL, currently working on Youtube and Twitch VODs.
  - Works well with Brave's memory saver feature. If you set memory saver to aggressive mode and the browser decides to put your youtube tab to "sleep", after you come back to the tab with the half-finished video you would've lost where you last were because it would automatically refresh to go from sleeping to being awake.
## Mouse macro
Record a series of mouse actions and play them back automatically. Press ALT + R to start recording, press ALT + R to end recording. Press ALT + T to play the macro once, press ALT + Y to play the macro indefinitely in a loop.
  - Some extra work needed to be done for different SPA and JS frameworks to register macro clicks as actual clicks.
