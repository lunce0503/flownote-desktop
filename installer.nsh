; Only NSIS installations contain this marker. ZIP users receive a verified ZIP,
; not an installer that would move or overwrite their portable directory.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\installed-by-nsis" w
  FileWrite $0 "Flownote"
  FileClose $0
!macroend
