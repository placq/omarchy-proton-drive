import QtQuick
import Quickshell.Io

Item {
    id: root
    property string omarchyPath
    property var shell
    property var manifest
    property var pluginRegistry
    property bool connected: false
    property string provider: "unconfigured"
    property var transfers: []
    property string lastError: ""

    Process {
        id: watch
        command: ["omarchy-drive-control", "watch"]
        running: true
        stdout: SplitParser { onRead: data => {
            try {
                const message=JSON.parse(data)
                if (message.event === "Status") { root.connected=Boolean(message.data.connected); root.provider=message.data.provider || "unconfigured"; root.lastError="" }
                if (message.event === "TransferChanged") {
                    const next=root.transfers.filter(item => item.id !== message.data.id)
                    if (!["complete", "cancelled"].includes(message.data.state)) next.push(message.data)
                    root.transfers=next
                }
                root.lastError=""
            } catch (e) { root.lastError="Invalid integration event" }
        }}
        onExited: exitCode => { root.connected=false; root.lastError="Integration is not running"; restart.start() }
    }
    Timer { id: restart; interval: 5000; repeat: false; onTriggered: watch.running=true }
}
