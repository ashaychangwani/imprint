# vhs tape — renders scripts/demo-teach.ts to a GIF for the README + website.
#   vhs scripts/demo-teach.tape   (run from repo root)
# Regenerate the GIF after changing the demo: see scripts/demo-teach.ts.
Output web/public/imprint-teach.gif

Set Shell "bash"
Set FontSize 15
Set Width 960
Set Height 600
Set Padding 16
Set Theme { "background": "#070d0c", "foreground": "#dff5e8", "black": "#1c2826", "red": "#ff7a45", "green": "#8fe388", "yellow": "#f9e2af", "blue": "#7be7d8", "magenta": "#cfa6ff", "cyan": "#7be7d8", "white": "#dff5e8", "brightBlack": "#5b6b66", "brightGreen": "#cfff58", "brightCyan": "#7be7d8", "cursor": "#cfff58", "selection": "#1c3a34" }
Set Framerate 20
Env DEMO_SPEED "1.4"

# launch the demo invisibly so the GIF opens on the demo's own "$ imprint teach …"
Hide
Type "bun scripts/demo-teach.ts"
Enter
Sleep 1.2s
Show
Sleep 24s
