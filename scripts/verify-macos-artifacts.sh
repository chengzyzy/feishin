#!/bin/bash
# Verifies the local arm64 DMG/ZIP before CI uploads them as artifacts.
set -euo pipefail

DIST_DIR="${1:-dist}"
EXPECTED_BUNDLE_ID="io.github.chengzyzy.feishin.local"
EXPECTED_APP_NAME="Feishin Local"
EXPECTED_DISPLAY_NAME="Feishin"
REPORT="$DIST_DIR/verification.txt"
TMP_DIR="$(mktemp -d)"
MOUNT_DIR="$TMP_DIR/dmg"
MOUNTED=0
cleanup() {
    if [[ "$MOUNTED" == 1 ]]; then
        hdiutil detach "$MOUNT_DIR" -quiet || return
    fi
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

: > "$REPORT"
log() { printf '%s\n' "$*" | tee -a "$REPORT"; }

shopt -s nullglob
dmgs=("$DIST_DIR"/*.dmg)
zips=("$DIST_DIR"/*.zip)
if [[ ${#dmgs[@]} -ne 1 || ${#zips[@]} -ne 1 ]]; then
    log "FAIL: expected one DMG and one ZIP in $DIST_DIR"
    exit 1
fi
DMG="${dmgs[0]}"
ZIP="${zips[0]}"

log "DMG=$DMG"
log "ZIP=$ZIP"
log "hdiutil verify:"
hdiutil verify "$DMG" 2>&1 | tee -a "$REPORT"

ditto -x -k "$ZIP" "$TMP_DIR/zip"
APP="$TMP_DIR/zip/$EXPECTED_APP_NAME.app"

verify_app() {
    local bundle="$1" bundle_id app_name display_name archs signature
    log "APP=$bundle"
    bundle_id="$(plutil -extract CFBundleIdentifier raw "$bundle/Contents/Info.plist")"
    app_name="$(plutil -extract CFBundleName raw "$bundle/Contents/Info.plist")"
    display_name="$(plutil -extract CFBundleDisplayName raw "$bundle/Contents/Info.plist")"
    archs="$(lipo -archs "$bundle/Contents/MacOS/$EXPECTED_APP_NAME")"
    log "CFBundleIdentifier=$bundle_id"
    log "CFBundleName=$app_name"
    log "CFBundleDisplayName=$display_name"
    log "architecture=$archs"
    [[ "$bundle_id" == "$EXPECTED_BUNDLE_ID" ]]
    [[ "$app_name" == "$EXPECTED_APP_NAME" ]]
    [[ "$display_name" == "$EXPECTED_DISPLAY_NAME" ]]
    [[ "$archs" == arm64 ]]
    codesign --verify --deep --strict --verbose=2 "$bundle" 2>&1 | tee -a "$REPORT"
    signature="$(codesign -d --verbose=4 "$bundle" 2>&1)"
    log "$signature"
    grep -Fxq 'Signature=adhoc' <<< "$signature"
}

verify_app "$APP"
mkdir "$MOUNT_DIR"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MOUNT_DIR" "$DMG"
MOUNTED=1
verify_app "$MOUNT_DIR/$EXPECTED_APP_NAME.app"

log "entitlements:"
codesign -d --entitlements :- "$APP" > "$DIST_DIR/entitlements.plist"
if [[ -s "$DIST_DIR/entitlements.plist" ]]; then
    plutil -p "$DIST_DIR/entitlements.plist" 2>&1 | tee -a "$REPORT"
fi

log "ZIP contents:"
unzip -l "$ZIP" | tee -a "$REPORT" | sed -n '1,40p'

(cd "$DIST_DIR" && shasum -a 256 "${DMG##*/}" "${ZIP##*/}") | tee "$DIST_DIR/SHA256SUMS"
log "PASS"
