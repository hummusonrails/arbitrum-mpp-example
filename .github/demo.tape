Output .github/media/demo.gif
Output .github/media/demo.mp4

Set Shell bash
Set FontFamily "Menlo"
Set FontSize 24
Set Width 1040
Set Height 860
Set Padding 24
Set Framerate 15
Set TypingSpeed 90ms
Set Theme {"name":"Arbitrum","background":"#213147","foreground":"#FFFFFF","cursor":"#12AAFF","black":"#213147","red":"#9DCCED","green":"#9DCCED","yellow":"#9DCCED","blue":"#12AAFF","magenta":"#9DCCED","cyan":"#12AAFF","white":"#FFFFFF","brightBlack":"#9DCCED","brightRed":"#9DCCED","brightGreen":"#9DCCED","brightYellow":"#9DCCED","brightBlue":"#12AAFF","brightMagenta":"#9DCCED","brightCyan":"#12AAFF","brightWhite":"#FFFFFF"}

Env PS1 "$ "
Env ENV_FILE "/dev/null"
Env FORCE_COLOR "1"
Env NO_COLOR ""
Env TERM "xterm-256color"

Type "pnpm --silent demo"
Sleep 500ms
Enter
Wait+Screen /Local chain and server stopped/
Sleep 8s
