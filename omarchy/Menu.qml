import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons

Item {
    id: root
    property string omarchyPath
    property var shell
    property var manifest
    property var pluginRegistry
    property bool shown: false
    property bool available: false
    property string statusText: "Checking integration…"
    property var transfers: []
    function open(payloadJson) { shown=true; status.running=true }
    function close() { shown=false }
    Process { id: status; command: ["omarchy-drive-control", "status"]; stdout: StdioCollector { onStreamFinished: {
        try { const value=JSON.parse(text); root.available=true; root.transfers=value.transfers || []; root.statusText=value.provider === "fake" ? "Developer preview · Fake Drive" : (value.connected ? "Connected" : "Sign-in integration unavailable in this alpha") }
        catch (e) { root.available=false; root.statusText="System integration is not running" }
    } } }
    Process { id: openDrive; command: ["omarchy-drive-control", "open"] }
    PopupWindow {
        visible: root.shown
        implicitWidth: 380; implicitHeight: 400
        color: Color.background
        Rectangle {
            anchors.fill: parent; radius: Style.cornerRadius; color: Color.background; border.color: Color.foreground; border.width: 1
            Column {
                anchors.fill: parent; anchors.margins: 24; spacing: 16
                Text { text: "Proton Drive"; color: Color.foreground; font.pixelSize: Style.font.heading; font.bold: true }
                Text { id: summary; text: root.statusText; color: Color.foreground; opacity: .72; wrapMode: Text.Wrap; width: parent.width }
                Text { text: "Transfers"; visible: root.transfers.length > 0; color: Color.foreground; font.bold: true }
                Repeater {
                    model: root.transfers.slice(0, 3)
                    delegate: Column {
                        required property var modelData
                        width: parent.width; spacing: 4
                        Text { text: (modelData.direction === "upload" ? "↑ " : "↓ ") + modelData.name; color: Color.foreground; elide: Text.ElideMiddle; width: parent.width }
                        ProgressBar { width: parent.width; from: 0; to: Math.max(1, modelData.bytesTotal); value: modelData.bytesDone }
                    }
                }
                Button { text: "Open Proton Drive"; enabled: root.available; onClicked: openDrive.running=true }
                Text { text: "Unofficial third-party integration. Not affiliated with Proton AG."; color: Color.foreground; opacity: .5; wrapMode: Text.Wrap; width: parent.width; font.pixelSize: Style.font.caption }
            }
        }
    }
}
