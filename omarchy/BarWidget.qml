import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
    id: root
    moduleName: "placq.proton-drive"

    readonly property var driveService: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
    readonly property bool connected: driveService ? driveService.connected : false
    readonly property string provider: driveService ? driveService.provider : "unconfigured"
    readonly property bool readOnly: driveService ? driveService.readOnly : false
    readonly property bool needsAttention: driveService && driveService.lastError !== ""
        || (!connected && provider !== "unconfigured")
    readonly property bool transferring: connected && driveService && driveService.transfers.length > 0
    readonly property string statusLabel: {
        if (driveService && driveService.lastError !== "") return "Wymaga uwagi"
        if (connected) return driveService && driveService.transfers.length > 0 ? "Trwa pobieranie" : (readOnly ? "Połączono · Tylko do odczytu" : "Połączono")
        return provider === "unconfigured" ? "Nieskonfigurowany" : "Wymagane logowanie"
    }
    property bool popupOpen: false

    function close() { popupOpen = false }
    function formatBytes(bytes) {
        const value = Math.max(0, Number(bytes) || 0)
        if (value < 1024) return value.toFixed(0) + " B"
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB"
        if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MiB"
        return (value / 1024 / 1024 / 1024).toFixed(1) + " GiB"
    }
    readonly property real usageRatio: driveService && driveService.totalBytes > 0
        ? Math.min(1, driveService.usedBytes / driveService.totalBytes) : 0
    visible: true
    implicitWidth: Style.space(24)
    implicitHeight: barSize

    ProtonDriveIcon {
        anchors.centerIn: parent
        iconSize: Style.space(14)
        color: Color.bar.text
        opacity: 1.0
    }

    Rectangle {
        visible: root.transferring || root.needsAttention
        width: Style.space(4)
        height: width
        radius: width / 2
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.rightMargin: Style.space(2)
        anchors.topMargin: Style.space(4)
        color: root.needsAttention ? Color.bar.active : Color.bar.text
    }

    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.LeftButton
        cursorShape: Qt.PointingHandCursor
        onClicked: root.popupOpen = !root.popupOpen
        onEntered: if (root.bar) root.bar.showTooltip(root, "Proton Drive · " + root.statusLabel)
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

            PanelHero {
                width: parent.width
                title: "Proton Drive"
                meta: root.driveService ? root.driveService.accountEmail : ""
                foreground: Color.popups.text
                fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                iconComponent: Component {
                    ProtonDriveIcon {
                        iconSize: Style.font.display
                        color: Color.popups.text
                    }
                }
            }

            PanelSeparator {
                width: parent.width
                foreground: Color.popups.text
            }

            Column {
                visible: root.connected
                width: parent.width
                spacing: Style.space(5)

                Text {
                    text: root.driveService
                        ? root.formatBytes(root.driveService.usedBytes) + " zajęte z " + root.formatBytes(root.driveService.totalBytes)
                        : ""
                    color: Color.popups.text
                    font.pixelSize: Style.font.bodySmall
                }

                Rectangle {
                    width: parent.width
                    height: Style.space(6)
                    radius: height / 2
                    color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.16)

                    Rectangle {
                        width: parent.width * root.usageRatio
                        height: parent.height
                        radius: height / 2
                        color: Color.accent
                    }
                }
            }

            Column {
                visible: root.connected
                width: parent.width
                spacing: Style.space(2)

                Text {
                    text: root.readOnly ? "Połączono · Tylko do odczytu" : "Połączono"
                    color: Color.popups.text
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                }

            }

            Column {
                visible: root.driveService && root.driveService.transfers.length > 0
                width: parent.width
                spacing: Style.space(7)

                Text {
                    text: "Aktywne operacje"
                    color: Color.popups.text
                    font.pixelSize: Style.font.bodySmall
                    font.bold: true
                }

                Repeater {
                    model: root.driveService ? root.driveService.transfers : []
                    delegate: Column {
                        required property var modelData
                        width: parent.width
                        spacing: Style.space(3)

                        Text {
                            text: (modelData.direction === "upload" ? "Wysyłanie: " : "Pobieranie: ") + modelData.name
                            color: Color.popups.text
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideMiddle
                            width: parent.width
                        }

                        Rectangle {
                            width: parent.width
                            height: Style.space(4)
                            radius: height / 2
                            color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.16)
                            Rectangle {
                                width: parent.width * (modelData.bytesTotal > 0 ? Math.min(1, modelData.bytesDone / modelData.bytesTotal) : 0)
                                height: parent.height
                                radius: height / 2
                                color: Color.accent
                            }
                        }
                    }
                }
            }

            Column {
                visible: root.driveService && root.driveService.lastError !== ""
                width: parent.width
                spacing: Style.space(6)

                Text {
                    text: root.driveService ? root.driveService.lastError : ""
                    color: Color.popups.text
                    wrapMode: Text.Wrap
                    width: parent.width
                    font.pixelSize: Style.font.bodySmall
                }

                Button {
                    width: parent.width
                    text: "Spróbuj ponownie"
                    bordered: true
                    foreground: Color.popups.text
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    onClicked: {
                        root.bar.run("omarchy-drive-control sync")
                        if (root.driveService) root.driveService.refreshSoon()
                    }
                }
            }

            Row {
                visible: root.connected
                width: parent.width
                spacing: Style.space(8)

                Text {
                    text: "Zajęte miejsce lokalnie: " + (root.driveService ? root.formatBytes(root.driveService.cacheBytes) : "0 B")
                    color: Color.popups.text
                    font.pixelSize: Style.font.caption
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width - clearCacheButton.width - parent.spacing
                }

                Button {
                    id: clearCacheButton
                    text: "Zwolnij miejsce"
                    bordered: true
                    foreground: Color.popups.text
                    fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                    fontSize: Style.font.caption
                    onClicked: {
                        root.bar.run("omarchy-drive-control clear-cache")
                        if (root.driveService) root.driveService.refreshSoon()
                    }
                }
            }

            Button {
                visible: !root.connected && (!root.driveService || root.driveService.lastError === "")
                width: parent.width
                text: "Zaloguj się"
                bordered: true
                foreground: Color.popups.text
                fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                onClicked: {
                    root.bar.run("omarchy-drive-control login")
                    root.popupOpen = false
                }
            }

            Button {
                visible: root.connected
                width: parent.width
                text: "Wyloguj się"
                bordered: true
                foreground: Color.popups.text
                fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
                onClicked: {
                    root.bar.run("omarchy-drive-control logout")
                    root.popupOpen = false
                }
            }

            Text {
                visible: root.driveService && root.driveService.version !== ""
                text: "Proton Drive for Omarchy " + (root.driveService ? root.driveService.version : "")
                color: Color.popups.text
                opacity: 0.45
                font.pixelSize: Style.font.caption
                width: parent.width
                horizontalAlignment: Text.AlignHCenter
            }
        }
    }
}
