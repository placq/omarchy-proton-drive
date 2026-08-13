import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
    id: root
    moduleName: "placq.proton-drive"

    readonly property var driveService: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
    readonly property bool connected: driveService ? driveService.connected : false
    readonly property string provider: driveService ? driveService.provider : "unconfigured"
    readonly property string statusIcon: {
        if (driveService && driveService.lastError !== "") return "☁!"
        if (connected) {
            if (driveService && driveService.transfers.length > 0) return "☁↑"
            return "☁"
        }
        return provider === "unconfigured" ? "☁?" : "☁!"
    }
    readonly property string statusLabel: {
        if (driveService && driveService.lastError !== "") return "Integration error"
        if (connected) return driveService && driveService.transfers.length > 0 ? "Syncing" : "Connected"
        return provider === "unconfigured" ? "Not configured" : "Sign-in required"
    }
    property bool popupOpen: false

    visible: true
    implicitWidth: row.implicitWidth + Style.space(12)
    implicitHeight: barSize

    Row {
        id: row
        anchors.centerIn: parent
        spacing: Style.space(6)

        Text {
            text: "Proton Drive:"
            color: root.bar ? root.bar.barForeground : Color.foreground
            font.family: root.bar ? root.bar.fontFamily : " sans"
            font.pixelSize: Style.font.body
            anchors.verticalCenter: parent.verticalCenter
        }

        Text {
            text: root.statusIcon
            color: root.bar ? root.bar.barForeground : Color.foreground
            font.family: root.bar ? root.bar.fontFamily : " sans"
            font.pixelSize: Style.font.body
            anchors.verticalCenter: parent.verticalCenter
        }
    }

    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        cursorShape: Qt.PointingHandCursor
        onClicked: root.popupOpen = !root.popupOpen
        onEntered: if (root.bar) root.bar.showTooltip(root, root.statusLabel)
        onExited: if (root.bar) root.bar.hideTooltip(root)
    }

    PopupCard {
        id: popup
        anchorItem: root
        bar: root.bar
        owner: root
        open: root.popupOpen
        contentWidth: popup.fittedContentWidth(Style.space(300))
        contentHeight: popup.fittedContentHeight(details.implicitHeight)

        Column {
            id: details
            anchors.fill: parent
            spacing: Style.space(10)

            Text {
                text: "Proton Drive"
                color: root.bar ? root.bar.foreground : Color.foreground
                font.pixelSize: Style.font.subtitle
                font.bold: true
            }

            Text {
                text: root.statusLabel
                color: root.bar ? root.bar.foreground : Color.foreground
                font.pixelSize: Style.font.body
            }

            Text {
                visible: !root.connected
                text: root.provider === "unconfigured"
                    ? "Connect your Proton account to use Drive."
                    : "Your Proton session requires attention."
                color: root.bar ? root.bar.foreground : Color.foreground
                opacity: 0.72
                wrapMode: Text.Wrap
                width: parent.width
            }

            Text {
                visible: root.driveService && root.driveService.transfers.length > 0
                text: "Active transfers: " + (root.driveService ? root.driveService.transfers.length : 0)
                color: root.bar ? root.bar.foreground : Color.foreground
            }

            Text {
                text: root.connected
                    ? "Click Open Proton Drive to browse your files."
                    : "Account connection will be available when Proton authentication is enabled."
                color: root.bar ? root.bar.foreground : Color.foreground
                opacity: 0.72
                wrapMode: Text.Wrap
                width: parent.width
            }

            Rectangle {
                visible: root.connected
                width: parent.width
                height: Style.space(36)
                radius: Style.cornerRadius
                color: root.bar ? root.bar.barBackground : Color.background

                Text {
                    anchors.centerIn: parent
                    text: "Open Proton Drive"
                    color: root.bar ? root.bar.barForeground : Color.foreground
                    font.pixelSize: Style.font.body
                }

                MouseArea {
                    anchors.fill: parent
                    onClicked: {
                        root.bar.run("omarchy-drive-control open")
                        root.popupOpen = false
                    }
                }
            }
        }
    }
}
