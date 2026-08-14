import QtQuick
import QtQuick.Effects
import qs.Commons

Item {
    id: root

    property real iconSize: Style.font.icon
    property color color: Color.foreground

    implicitWidth: iconSize
    implicitHeight: iconSize
    width: iconSize
    height: iconSize

    Image {
        id: sourceIcon
        anchors.centerIn: parent
        width: root.iconSize
        height: root.iconSize
        source: Qt.resolvedUrl("assets/icon.png")
        fillMode: Image.PreserveAspectFit
        smooth: true
        mipmap: true
        visible: false
        layer.enabled: true
    }

    MultiEffect {
        anchors.fill: sourceIcon
        source: sourceIcon
        colorization: 1.0
        colorizationColor: root.color
    }
}
