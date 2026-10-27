# Minimal org.freedesktop.NetworkManager on a private bus: "connected, full connectivity".
import os
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
bus = dbus.bus.BusConnection(os.environ["CG_BUS"])
name = dbus.service.BusName("org.freedesktop.NetworkManager", bus)
NM = "org.freedesktop.NetworkManager"
NONE = dbus.ObjectPath("/")
PROPS = {
    "State": dbus.UInt32(70),
    "Connectivity": dbus.UInt32(4),
    "NetworkingEnabled": True,
    "WirelessEnabled": False,
    "WirelessHardwareEnabled": False,
    "WwanEnabled": False,
    "WwanHardwareEnabled": False,
    "Version": "1.42.4",
    "Devices": dbus.Array([], signature="o"),
    "AllDevices": dbus.Array([], signature="o"),
    "ActiveConnections": dbus.Array([], signature="o"),
    "Checkpoints": dbus.Array([], signature="o"),
    "Capabilities": dbus.Array([], signature="u"),
    "PrimaryConnection": NONE,
    "ActivatingConnection": NONE,
    "PrimaryConnectionType": "",
    "Startup": False,
    "Metered": dbus.UInt32(4),
    "ConnectivityCheckAvailable": True,
    "ConnectivityCheckEnabled": True,
    "ConnectivityCheckUri": "",
    "GlobalDnsConfiguration": dbus.Dictionary({}, signature="sv"),
}
SETTINGS = {
    "Connections": dbus.Array([], signature="o"),
    "Hostname": "cg",
    "CanModify": False,
}
OBJ = "/org/freedesktop/NetworkManager"
DEV = dbus.ObjectPath(OBJ + "/Devices/1")
AC = dbus.ObjectPath(OBJ + "/ActiveConnection/1")
IP4 = dbus.ObjectPath(OBJ + "/IP4Config/1")
CONN = dbus.ObjectPath(OBJ + "/Settings/1")
PROPS["Devices"] = dbus.Array([DEV], signature="o")
PROPS["AllDevices"] = dbus.Array([DEV], signature="o")
PROPS["ActiveConnections"] = dbus.Array([AC], signature="o")
PROPS["PrimaryConnection"] = AC
PROPS["PrimaryConnectionType"] = "802-3-ethernet"
SETTINGS["Connections"] = dbus.Array([CONN], signature="o")
DEVICE = {
    "Udi": "/sys/devices/virtual/net/eth0",
    "Path": "",
    "Interface": "eth0",
    "IpInterface": "eth0",
    "Driver": "veth",
    "DriverVersion": "1.0",
    "FirmwareVersion": "",
    "Capabilities": dbus.UInt32(3),
    "State": dbus.UInt32(100),
    "StateReason": dbus.Struct((dbus.UInt32(100), dbus.UInt32(0)), signature="uu"),
    "ActiveConnection": AC,
    "Ip4Config": IP4,
    "Dhcp4Config": NONE,
    "Ip6Config": NONE,
    "Dhcp6Config": NONE,
    "Managed": True,
    "Autoconnect": True,
    "FirmwareMissing": False,
    "NmPluginMissing": False,
    "DeviceType": dbus.UInt32(1),
    "AvailableConnections": dbus.Array([CONN], signature="o"),
    "PhysicalPortId": "",
    "Mtu": dbus.UInt32(1500),
    "Metered": dbus.UInt32(4),
    "LldpNeighbors": dbus.Array([], signature="a{sv}"),
    "Real": True,
    "Ip4Connectivity": dbus.UInt32(4),
    "Ip6Connectivity": dbus.UInt32(1),
    "InterfaceFlags": dbus.UInt32(0x10003),
    "HwAddress": "02:42:AC:11:00:02",
    "Ports": dbus.Array([], signature="o"),
}
WIRED = {
    "HwAddress": "02:42:AC:11:00:02",
    "PermHwAddress": "02:42:AC:11:00:02",
    "Speed": dbus.UInt32(1000),
    "S390Subchannels": dbus.Array([], signature="s"),
    "Carrier": True,
}
ACTIVE = {
    "Connection": CONN,
    "SpecificObject": NONE,
    "Id": "Wired connection 1",
    "Uuid": "6f0f3c5e-0000-4000-8000-000000000001",
    "Type": "802-3-ethernet",
    "Devices": dbus.Array([DEV], signature="o"),
    "State": dbus.UInt32(2),
    "StateFlags": dbus.UInt32(0),
    "Default": True,
    "Ip4Config": IP4,
    "Dhcp4Config": NONE,
    "Default6": False,
    "Ip6Config": NONE,
    "Dhcp6Config": NONE,
    "Vpn": False,
    "Controller": NONE,
    "Master": NONE,
}
IP4PROPS = {
    "AddressData": dbus.Array(
        [dbus.Dictionary({"address": "172.17.0.2", "prefix": dbus.UInt32(16)}, signature="sv")],
        signature="a{sv}",
    ),
    "Gateway": "172.17.0.1",
    "RouteData": dbus.Array([], signature="a{sv}"),
    "NameserverData": dbus.Array([], signature="a{sv}"),
    "Domains": dbus.Array([], signature="s"),
    "Searches": dbus.Array([], signature="s"),
    "DnsOptions": dbus.Array([], signature="s"),
    "DnsPriority": 100,
    "WinsServerData": dbus.Array([], signature="s"),
}


class Root(dbus.service.Object):
    @dbus.service.method("org.freedesktop.DBus.ObjectManager", out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return {
            dbus.ObjectPath(OBJ): {NM: PROPS},
            dbus.ObjectPath(OBJ + "/Settings"): {NM + ".Settings": SETTINGS},
            DEV: {NM + ".Device": DEVICE, NM + ".Device.Wired": WIRED},
            AC: {NM + ".Connection.Active": ACTIVE},
            IP4: {NM + ".IP4Config": IP4PROPS},
            CONN: {NM + ".Settings.Connection": dbus.Dictionary({"Unsaved": False, "Flags": dbus.UInt32(0), "Filename": ""}, signature="sv")},
        }


class Props(dbus.service.Object):
    def __init__(self, path, iface, props):
        super().__init__(bus, path)
        self.iface, self.props = iface, props

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
    def Get(self, iface, prop):
        return self.props[prop]

    @dbus.service.signal("org.freedesktop.DBus.Properties", signature="sa{sv}as")
    def PropertiesChanged(self, iface, changed, invalidated):
        pass

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        return self.props if iface == self.iface else dbus.Dictionary({}, signature="sv")


class Manager(Props):
    @dbus.service.signal(NM, signature="u")
    def StateChanged(self, state):
        pass

    @dbus.service.method(NM, out_signature="u")
    def state(self):
        return dbus.UInt32(70)

    @dbus.service.method(NM, out_signature="u")
    def CheckConnectivity(self):
        return dbus.UInt32(4)

    @dbus.service.method(NM, out_signature="ao")
    def GetDevices(self):
        return dbus.Array([], signature="o")

    @dbus.service.method(NM, out_signature="ao")
    def GetAllDevices(self):
        return dbus.Array([], signature="o")

    @dbus.service.method(NM, out_signature="a{ss}")
    def GetPermissions(self):
        return dbus.Dictionary({}, signature="ss")


class Device(Props):
    @dbus.service.signal(NM + ".Device", signature="uuu")
    def StateChanged(self, new, old, reason):
        pass


Root(bus, "/org/freedesktop")
manager = Manager(OBJ, NM, PROPS)
Props(OBJ + "/Settings", NM + ".Settings", SETTINGS)
device = Device(DEV, NM + ".Device", {**DEVICE, **WIRED})
Props(AC, NM + ".Connection.Active", ACTIVE)
Props(IP4, NM + ".IP4Config", IP4PROPS)


def tick():
    manager.StateChanged(dbus.UInt32(70))
    manager.PropertiesChanged(NM, dbus.Dictionary({"State": PROPS["State"], "Connectivity": PROPS["Connectivity"]}, signature="sv"), dbus.Array([], signature="s"))
    device.StateChanged(dbus.UInt32(100), dbus.UInt32(100), dbus.UInt32(0))
    return True


GLib.timeout_add_seconds(2, tick)
print("nm-stub ready", flush=True)
GLib.MainLoop().run()
