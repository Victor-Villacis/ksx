/* Manual MSVC configuration for the KSX libwdi prepare provider. */
#pragma once

#ifndef _MSC_VER
#error "third_party/libwdi/msvc/config.h is for MSVC builds only"
#endif

/* Supported KSX packages use Windows' in-box WinUSB service. */
/* WDK_DIR, LIBUSB0_DIR, LIBUSBK_DIR, and USER_DIR stay undefined. */

/* Token definitions remain for upstream source compatibility. */
#define WDF_VER 1011
#define COINSTALLER_DIR "wdf"
#define X64_DIR "x64"

/* The distributed provider is x64 only. */
#define OPT_M64

/* Keep diagnostics available to the elevated helper. */
#define INCLUDE_DEBUG_LOGGING
#define ENABLE_LOGGING 1

