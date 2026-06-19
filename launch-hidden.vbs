' Launch the bridge with no visible console window. Portable — finds its own folder.
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "cmd /c """ & dir & "\run-bot.cmd""", 0, False
