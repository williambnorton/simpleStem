#!/bin/bash
# install_chrome_quick_action.sh — register a macOS Quick Action that takes a
# selected YouTube URL in Chrome and drops it into simpleStem's ingest pipeline
# via webloc_drop.sh.
#
# Why: avoid the trip to the simpleStem portal just to paste a URL. Right-click
# a YouTube link → Services → "Send to simpleStem" → done. End result is
# bit-identical to a portal paste — same INCOMING_WEBLOC drop, same downstream
# watcher → queue → demucs path.
#
# Non-obvious gotchas baked into this installer:
#   * Info.plist must NOT carry NSRequiredContext. A previous attempt set
#     NSRequiredContext to {NSApplicationIdentifier: ''} and the action
#     registered fine but silently never appeared in the Services menu.
#   * The Services menu is built at app launch. After install you MUST
#     fully quit Chrome (⌘Q, not just close the window) and reopen it.
#   * lsregister + pbs -flush + pbs -update is the canonical rebuild dance;
#     the installer runs them at the end so the new action is picked up
#     before you next launch Chrome.
#
# Usage:
#   ./install_chrome_quick_action.sh           # install / refresh
#   ./install_chrome_quick_action.sh --uninstall
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$DIR/webloc_drop.sh"

WORKFLOW_NAME="Send to simpleStem"
SERVICES="$HOME/Library/Services"
BUNDLE="$SERVICES/${WORKFLOW_NAME}.workflow"
CONTENTS="$BUNDLE/Contents"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$BUNDLE"
  /System/Library/CoreServices/pbs -flush 2>/dev/null || true
  /System/Library/CoreServices/pbs -update 2>/dev/null || true
  echo "Removed: $BUNDLE"
  exit 0
fi

if [[ ! -x "$HELPER" ]]; then
  chmod +x "$HELPER" 2>/dev/null || {
    echo "webloc_drop.sh missing or not executable at $HELPER" >&2
    exit 1
  }
fi

mkdir -p "$CONTENTS"

# AppleScript embedded in the workflow. Receives the selection as `input`,
# hands the URL to webloc_drop.sh (which trims whitespace + validates),
# and surfaces a brief notification so the user knows what happened.
read -r -d '' APPLESCRIPT <<APPLESCRIPT_EOF || true
on run {input, parameters}
	set urlText to ""
	if class of input is list then
		if (count of input) > 0 then set urlText to item 1 of input as text
	else
		set urlText to input as text
	end if
	if urlText is "" then
		display notification "Empty selection" with title "simpleStem" subtitle "Send to simpleStem"
		return input
	end if
	try
		do shell script quoted form of "${HELPER}" & " " & quoted form of urlText
		display notification urlText with title "simpleStem" subtitle "Queued for ingest"
	on error errMsg number errNum
		display notification errMsg with title "simpleStem" subtitle "Failed (" & errNum & ")"
	end try
	return input
end run
APPLESCRIPT_EOF

# Info.plist — the NSServices entry. The Services menu reads from this on
# pbs -update. Note absence of NSRequiredContext: do NOT add it.
cat >"$CONTENTS/Info.plist" <<INFO_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${WORKFLOW_NAME}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSSendTypes</key>
			<array>
				<string>public.utf8-plain-text</string>
				<string>public.plain-text</string>
				<string>NSStringPboardType</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
INFO_EOF

# document.wflow — the Automator workflow document itself. Generated via
# python plistlib so XML escaping of the embedded AppleScript (which is
# full of & symbols, parens, and quotes) is handled correctly. APPLESCRIPT
# is passed via env var so the single-quoted heredoc doesn't try to expand
# any of its $ / ! / backtick characters.
APPLESCRIPT="$APPLESCRIPT" python3 - "$CONTENTS/document.wflow" <<'PY_EOF'
import plistlib, sys, uuid, os

APPLESCRIPT = os.environ.get("APPLESCRIPT", "")

doc = {
    "AMApplicationBuild": "492",
    "AMApplicationVersion": "2.10",
    "AMDocumentVersion": "2",
    "actions": [{
        "action": {
            "AMAccepts": {
                "Container": "List",
                "Optional": True,
                "Types": ["com.apple.applescript.object"],
            },
            "AMActionVersion": "1.0.2",
            "AMApplication": ["Automator"],
            "AMParameterProperties": {"source": {}},
            "AMProvides": {
                "Container": "List",
                "Types": ["com.apple.applescript.object"],
            },
            "ActionBundlePath": "/System/Library/Automator/Run AppleScript.action",
            "ActionName": "Run AppleScript",
            "ActionParameters": {"source": APPLESCRIPT},
            "BundleIdentifier": "com.apple.Automator.RunScript",
            "CFBundleVersion": "1.0.2",
            "CanShowSelectedItemsWhenRun": False,
            "CanShowWhenRun": True,
            "Category": ["AMCategoryUtilities"],
            "Class Name": "RunScriptAction",
            "InputUUID": str(uuid.uuid4()).upper(),
            "Keywords": ["Run"],
            "OutputUUID": str(uuid.uuid4()).upper(),
            "UUID": str(uuid.uuid4()).upper(),
            "UnlocalizedApplications": ["Automator"],
            "arguments": {},
            "isViewVisible": 1,
            "location": "309.500000:316.000000",
            "nibPath": "/System/Library/Automator/Run AppleScript.action/Contents/Resources/Base.lproj/main.nib",
        },
        "isViewVisible": 1,
    }],
    "connectors": {},
    "workflowMetaData": {
        "serviceInputTypeIdentifier": "com.apple.Automator.text",
        "serviceOutputTypeIdentifier": "com.apple.Automator.nothing",
        "serviceProcessesInput": 0,
        "workflowTypeIdentifier": "com.apple.Automator.servicesMenu",
    },
}

with open(sys.argv[1], "wb") as f:
    plistlib.dump(doc, f, fmt=plistlib.FMT_XML)
PY_EOF

# Register + flush so the Services menu picks up the new action. Chrome
# still has to be quit + reopened — Services menus are read at app launch.
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREG" -f "$BUNDLE" >/dev/null 2>&1 || true
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true
/System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true

echo "Installed: $BUNDLE"
echo "Helper:    $HELPER"
echo
echo "Next steps:"
echo "  1. Quit Chrome fully (⌘Q — not just close the window)."
echo "  2. Reopen Chrome."
echo "  3. Right-click a selected YouTube URL → Services → '${WORKFLOW_NAME}'."
echo
echo "If the menu item is missing after a Chrome relaunch, open"
echo "System Settings → Keyboard → Keyboard Shortcuts → Services → Text and"
echo "confirm the '${WORKFLOW_NAME}' checkbox is on."
