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
    property bool readOnly: false
    property var transfers: []
    property string lastError: ""
    property string accountEmail: ""
    property string accountName: ""
    property real usedBytes: 0
    property real totalBytes: 0
    property real cacheBytes: 0
    property string version: ""
    property string connectionError: ""

    function applyStatus(data) {
        const account=data.account || {}
        root.connected=Boolean(data.connected)
        root.provider=data.provider || "unconfigured"
        root.readOnly=Boolean(data.readOnly)
        root.accountEmail=account.email || ""
        root.accountName=account.displayName || ""
        root.usedBytes=Number(account.usedBytes || 0)
        root.totalBytes=Number(account.totalBytes || 0)
        root.cacheBytes=Number(data.cacheBytes || 0)
        root.version=data.version || ""
        root.connectionError=data.connectionError || ""
        root.transfers=data.transfers || root.transfers
        root.lastError=root.connectionError
    }

    function refreshSoon() { refreshDelay.restart() }

    Process {
        id: watch
        command: ["omarchy-drive-control", "watch"]
        running: true
        stdout: SplitParser { onRead: data => {
            try {
                const message=JSON.parse(data)
                if (message.event === "Status") root.applyStatus(message.data)
                if (message.event === "TransferChanged") {
                    const next=root.transfers.filter(item => item.id !== message.data.id)
                    if (!["complete", "cancelled"].includes(message.data.state)) next.push(message.data)
                    root.transfers=next
                    if (message.data.state === "failed") root.lastError=message.data.error || "Transfer failed"
                }
            } catch (e) { root.lastError="Invalid integration event" }
        }}
        onExited: exitCode => { root.connected=false; root.lastError="Integration is not running"; restart.start() }
    }
    Timer { id: restart; interval: 5000; repeat: false; onTriggered: watch.running=true }

    Process {
        id: statusPoll
        command: ["omarchy-drive-control", "status"]
        running: true
        stdout: SplitParser { onRead: data => {
            try { root.applyStatus(JSON.parse(data)) }
            catch (e) { root.lastError="Invalid status response" }
        }}
    }
    Timer {
        interval: 60000
        running: true
        repeat: true
        onTriggered: if (!statusPoll.running) statusPoll.running=true
    }
    Timer {
        id: refreshDelay
        interval: 1500
        repeat: false
        onTriggered: if (!statusPoll.running) statusPoll.running=true
    }
}
