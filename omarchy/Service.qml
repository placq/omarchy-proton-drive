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
    property var conflicts: []
    property var notifiedConflicts: []
    property string lastError: ""
    property string accountEmail: ""
    property string accountName: ""
    property real usedBytes: 0
    property real totalBytes: 0
    property real cacheBytes: 0
    property string version: ""
    property string connectionError: ""
    property bool loading: true
    property bool integrationFailed: false

    function applyStatus(data) {
        const expectedVersion=root.manifest && root.manifest.version ? root.manifest.version : "0.3.0-alpha.2"
        if (Number(data.apiVersion || 0) !== 1 || String(data.version || "") !== String(expectedVersion)) {
            root.connected=false
            root.loading=false
            root.integrationFailed=true
            root.lastError="Niezgodna wersja integracji. Zainstaluj ponownie Proton Drive."
            return
        }
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
        root.conflicts=data.conflicts || []
        root.loading=false
        root.integrationFailed=false
        root.lastError=root.connectionError
    }

    function refreshSoon() { refreshDelay.restart() }
    function beginLoading() {
        root.loading=true
        root.integrationFailed=false
        root.lastError=""
    }
    Process {
        id: watch
        command: ["omarchy-drive-control", "watch"]
        running: true
        stdout: SplitParser { onRead: data => {
            try {
                const message=JSON.parse(data)
                if (message.event === "Status") root.applyStatus(message.data)
                if (message.event === "Conflict") {
                    if (!root.conflicts.some(item => item.nodeId === message.data.nodeId)) root.conflicts=root.conflicts.concat([message.data])
                    if (!root.notifiedConflicts.includes(message.data.nodeId)) {
                        root.notifiedConflicts=root.notifiedConflicts.concat([message.data.nodeId])
                        if (root.shell && root.shell.bar && root.shell.bar.run) root.shell.bar.run("notify-send", ["--urgency=normal", "--icon=dialog-warning", "Proton Drive", "Zmiana lokalna jest w konflikcie z wersją zdalną. Rozwiąż konflikt na pasku."])
                    }
                }
                if (message.event === "ConflictResolved") {
                    root.conflicts=root.conflicts.filter(item => item.nodeId !== message.data.nodeId)
                    root.notifiedConflicts=root.notifiedConflicts.filter(id => id !== message.data.nodeId)
                }
                if (message.event === "TransferChanged") {
                    const next=root.transfers.filter(item => item.id !== message.data.id)
                    if (["queued", "running", "paused"].includes(message.data.state)) next.push(message.data)
                    root.transfers=next
                    if (message.data.state === "failed") root.lastError=message.data.error || "Transfer failed"
                }
            } catch (e) { root.lastError="Invalid integration event" }
        }}
        onExited: exitCode => {
            root.connected=false
            root.loading=true
            root.integrationFailed=true
            root.lastError=""
            restart.start()
            loadingTimeout.restart()
        }
    }
    Timer { id: restart; interval: 5000; repeat: false; onTriggered: watch.running=true }
    Timer {
        id: loadingTimeout
        interval: 10000
        repeat: false
        onTriggered: if (root.loading && root.integrationFailed) {
            root.loading=false
            root.lastError="Integration is not running"
        }
    }

    Process {
        id: statusPoll
        command: ["omarchy-drive-control", "status"]
        running: true
        stdout: SplitParser { onRead: data => {
            try { root.applyStatus(JSON.parse(data)) }
            catch (e) {
                root.integrationFailed=true
                root.lastError=""
                loadingTimeout.restart()
            }
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
