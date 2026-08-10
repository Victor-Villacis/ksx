/*
 * Deterministic KSX resource slice for libwdi.
 *
 * The production caller always supplies an external INF. The only embedded
 * tokenizer input is therefore an empty WinUSB catalog member list; libwdi
 * adds the generated INF itself after parsing this list. No executable,
 * driver, coinstaller, or WDK file is embedded in this DLL.
 */
#pragma once

static const unsigned char ksx_winusb_cat_template[] =
	"# KSX uses in-box WinUSB; the external INF is the only catalog member.\n";

/* The caller must provide this exact template (CRLF and LF are normalized
 * before comparison). Keeping the canonical bytes inside the provider makes
 * "external_inf" a data-flow boundary, not permission to sign an arbitrary
 * caller-authored driver package. */
static const unsigned char ksx_winusb_inf_template[] =
	"; #INF_FILENAME#\n"
	"; Copyright (c) 2010-2023 Pete Batard <pete@akeo.ie> (GNU LGPL)\n"
	"[Strings]\n"
	"DeviceName = \"#DEVICE_DESCRIPTION#\"\n"
	"VendorName = \"#DEVICE_MANUFACTURER#\"\n"
	"SourceName = \"#DEVICE_DESCRIPTION# Install Disk\"\n"
	"DeviceID   = \"#DEVICE_HARDWARE_ID#\"\n"
	"DeviceGUID = \"#DEVICE_INTERFACE_GUID#\"\n"
	"\n"
	"[Version]\n"
	"Signature   = \"$Windows NT$\"\n"
	"Class       = \"USBDevice\"\n"
	"ClassGuid   = {88bae032-5a81-49f0-bc3d-a4ff138216d6}\n"
	"Provider    = \"KSX\"\n"
	"CatalogFile = #CAT_FILENAME#\n"
	"DriverVer   = #DRIVER_DATE#, #DRIVER_VERSION#\n"
	"PnpLockdown = 1\n"
	"\n"
	"[Manufacturer]\n"
	"%VendorName% = ksxDevice,NTamd64.10.0\n"
	"\n"
	"[ksxDevice.NTamd64.10.0]\n"
	"%DeviceName% = USB_Install, USB\\%DeviceID%\n"
	"\n"
	"[USB_Install]\n"
	"Include = winusb.inf\n"
	"Needs   = WINUSB.NT\n"
	"\n"
	"[USB_Install.Services]\n"
	"Include = winusb.inf\n"
	"Needs   = WINUSB.NT.Services\n"
	"\n"
	"[USB_Install.HW]\n"
	"AddReg = #USE_DEVICE_INTERFACE_GUID#\n"
	"\n"
	"[NoDeviceInterfaceGUID]\n"
	"; Avoids adding a DeviceInterfaceGUID for generic driver\n"
	"\n"
	"[AddDeviceInterfaceGUID]\n"
	"HKR,,DeviceInterfaceGUIDs,0x10000,%DeviceGUID%\n"
	"\n";

struct res {
	char* subdir;
	char* name;
	size_t size;
	int64_t creation_time;
	const unsigned char* data;
};

static const struct res resource[] = {
	{ "", "winusb.cat.in", sizeof(ksx_winusb_cat_template) - 1, INT64_C(0), ksx_winusb_cat_template },
};

static const int nb_resources = sizeof(resource) / sizeof(resource[0]);
