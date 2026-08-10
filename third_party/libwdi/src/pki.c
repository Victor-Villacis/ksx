/*
 * libwdi: Library for automated Windows Driver Installation - PKI part
 * Copyright (c) 2011-2023 Pete Batard <pete@akeo.ie>
 * For more info, please visit http://libwdi.akeo.ie
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/* Memory leaks detection - define _CRTDBG_MAP_ALLOC as preprocessor macro */
#ifdef _CRTDBG_MAP_ALLOC
#include <stdlib.h>
#include <crtdbg.h>
#endif

#include <windows.h>
#include <bcrypt.h>
#include <setupapi.h>
#include <wincrypt.h>
#include <stdio.h>
#include <stdint.h>
#include <limits.h>
#include <string.h>
#include "mssign32.h"

#include <config.h>
#include "msapi_utf8.h"
#include "installer.h"
#include "libwdi.h"
#include "logging.h"
#include "stdfn.h"

#define KSX_KEY_CONTAINER_CHARS      80
#define KSX_CERT_VALIDITY_DAYS       3660ULL
#define KSX_CERT_START_SKEW_MINUTES  5ULL
#define PF_ERR                      wdi_err
#ifndef CERT_STORE_PROV_SYSTEM_A
#define CERT_STORE_PROV_SYSTEM_A    ((LPCSTR) 9)
#endif
#ifndef szOID_RSA_SHA1RSA
#define szOID_RSA_SHA1RSA           "1.2.840.113549.1.1.5"
#endif
#ifndef szOID_RSA_SHA256RSA
#define szOID_RSA_SHA256RSA         "1.2.840.113549.1.1.11"
#endif
#ifndef szOID_NIST_sha256
#define szOID_NIST_sha256           "2.16.840.1.101.3.4.2.1"
#endif
#ifndef CERT_NCRYPT_KEY_HANDLE_PROP_ID
#define CERT_NCRYPT_KEY_HANDLE_PROP_ID 78
#endif

/*
 * Crypt32.dll
 */
typedef HCERTSTORE (WINAPI *CertOpenStore_t)(
	LPCSTR lpszStoreProvider,
	DWORD dwMsgAndCertEncodingType,
	ULONG_PTR hCryptProv,
	DWORD dwFlags,
	const void *pvPara
);

typedef PCCERT_CONTEXT (WINAPI *CertCreateCertificateContext_t)(
	DWORD dwCertEncodingType,
	const BYTE *pbCertEncoded,
	DWORD cbCertEncoded
);

typedef PCCERT_CONTEXT (WINAPI *CertFindCertificateInStore_t)(
	HCERTSTORE hCertStore,
	DWORD dwCertEncodingType,
	DWORD dwFindFlags,
	DWORD dwFindType,
	const void *pvFindPara,
	PCCERT_CONTEXT pfPrevCertContext
);

typedef BOOL (WINAPI *CertAddCertificateContextToStore_t)(
	HCERTSTORE hCertStore,
	PCCERT_CONTEXT pCertContext,
	DWORD dwAddDisposition,
	PCCERT_CONTEXT *pStoreContext
);

typedef BOOL (WINAPI *CertSetCertificateContextProperty_t)(
	PCCERT_CONTEXT pCertContext,
	DWORD dwPropId,
	DWORD dwFlags,
	const void *pvData
);

typedef BOOL (WINAPI *CertDeleteCertificateFromStore_t)(
	PCCERT_CONTEXT pCertContext
);

typedef BOOL (WINAPI *CertFreeCertificateContext_t)(
	PCCERT_CONTEXT pCertContext
);

typedef BOOL (WINAPI *CertCloseStore_t)(
	HCERTSTORE hCertStore,
	DWORD dwFlags
);

typedef DWORD (WINAPI *CertGetNameStringA_t)(
	PCCERT_CONTEXT pCertContext,
	DWORD dwType,
	DWORD dwFlags,
	void *pvTypePara,
	LPCSTR pszNameString,
	DWORD cchNameString
);

typedef BOOL (WINAPI *CryptEncodeObject_t)(
	DWORD dwCertEncodingType,
	LPCSTR lpszStructType,
	const void *pvStructInfo,
	BYTE *pbEncoded,
	DWORD *pcbEncoded
);

typedef BOOL (WINAPI *CryptDecodeObject_t)(
	DWORD dwCertEncodingType,
	LPCSTR lpszStructType,
	const BYTE *pbEncoded,
	DWORD cbEncoded,
	DWORD dwFlags,
	void *pvStructInfo,
	DWORD *pcbStructInfo
);

typedef BOOL (WINAPI *CertStrToNameA_t)(
	DWORD dwCertEncodingType,
	LPCSTR pszX500,
	DWORD dwStrType,
	void *pvReserved,
	BYTE *pbEncoded,
	DWORD *pcbEncoded,
	LPCTSTR *ppszError
);

typedef BOOL (WINAPI *CryptAcquireCertificatePrivateKey_t)(
	PCCERT_CONTEXT pCert,
	DWORD dwFlags,
	void *pvReserved,
	ULONG_PTR *phCryptProvOrNCryptKey,
	DWORD *pdwKeySpec,
	BOOL *pfCallerFreeProvOrNCryptKey
);

typedef BOOL (WINAPI *CertAddEncodedCertificateToStore_t)(
	HCERTSTORE hCertStore,
	DWORD dwCertEncodingType,
	const BYTE *pbCertEncoded,
	DWORD cbCertEncoded,
	DWORD dwAddDisposition,
	PCCERT_CONTEXT *ppCertContext
);

// MiNGW32 doesn't know CERT_EXTENSIONS => redef
typedef struct _CERT_EXTENSIONS_ARRAY {
	DWORD cExtension;
	PCERT_EXTENSION rgExtension;
} CERT_EXTENSIONS_ARRAY, *PCERT_EXTENSIONS_ARRAY;

typedef PCCERT_CONTEXT (WINAPI *CertCreateSelfSignCertificate_t)(
	ULONG_PTR hCryptProvOrNCryptKey,
	PCERT_NAME_BLOB pSubjectIssuerBlob,
	DWORD dwFlags,
	PCRYPT_KEY_PROV_INFO pKeyProvInfo,
	PCRYPT_ALGORITHM_IDENTIFIER pSignatureAlgorithm,
	LPSYSTEMTIME pStartTime,
	LPSYSTEMTIME pEndTime,
	PCERT_EXTENSIONS_ARRAY pExtensions
);

// MinGW32 doesn't have these ones either
#ifndef CERT_ALT_NAME_URL
#define CERT_ALT_NAME_URL 7
#endif
#ifndef CERT_RDN_IA5_STRING
#define CERT_RDN_IA5_STRING 7
#endif
#ifndef szOID_PKIX_POLICY_QUALIFIER_CPS
#define szOID_PKIX_POLICY_QUALIFIER_CPS "1.3.6.1.5.5.7.2.1"
#endif

typedef struct _CERT_POLICY_QUALIFIER_INFO_REDEF {
	LPSTR            pszPolicyQualifierId;
	CRYPT_OBJID_BLOB Qualifier;
} CERT_POLICY_QUALIFIER_INFO_REDEF, *PCERT_POLICY_QUALIFIER_INFO_REDEF;

typedef struct _CERT_POLICY_INFO_ALT {
	LPSTR                             pszPolicyIdentifier;
	DWORD                             cPolicyQualifier;
	PCERT_POLICY_QUALIFIER_INFO_REDEF rgPolicyQualifier;
} CERT_POLICY_INFO_REDEF, *PCERT_POLICY_INFO_REDEF;

typedef struct _CERT_POLICIES_INFO_ARRAY {
	DWORD                   cPolicyInfo;
	PCERT_POLICY_INFO_REDEF rgPolicyInfo;
} CERT_POLICIES_INFO_ARRAY, *PCERT_POLICIES_INFO_ARRAY;

/*
 * WinTrust.dll
 */
#define CRYPTCAT_OPEN_CREATENEW			0x00000001
#define CRYPTCAT_OPEN_ALWAYS			0x00000002

#define CRYPTCAT_ATTR_AUTHENTICATED		0x10000000
#define CRYPTCAT_ATTR_UNAUTHENTICATED	0x20000000
#define CRYPTCAT_ATTR_NAMEASCII			0x00000001
#define CRYPTCAT_ATTR_NAMEOBJID			0x00000002
#define CRYPTCAT_ATTR_DATAASCII			0x00010000
#define CRYPTCAT_ATTR_DATABASE64		0x00020000
#define CRYPTCAT_ATTR_DATAREPLACE		0x00040000

#define SPC_UUID_LENGTH					16
#define SPC_URL_LINK_CHOICE				1
#define SPC_MONIKER_LINK_CHOICE			2
#define SPC_FILE_LINK_CHOICE			3
#define SHA256_HASH_LENGTH			32
/* KSX: catalogue MEMBER hashes are SHA-1, which is what upstream libwdi emits
 * and what Windows 10/11 accepts from Zadig today. This is the digest that
 * identifies a member inside the catalogue; it is not the signature. The
 * catalogue is still signed with the 4096-bit key and a SHA-256 signature. */
#define SHA1_HASH_LENGTH			20
#define SPC_PE_IMAGE_DATA_OBJID			"1.3.6.1.4.1.311.2.1.15"
#define SPC_CAB_DATA_OBJID				"1.3.6.1.4.1.311.2.1.25"

typedef BYTE SPC_UUID[SPC_UUID_LENGTH];
typedef struct _SPC_SERIALIZED_OBJECT {
	SPC_UUID ClassId;
	CRYPT_DATA_BLOB SerializedData;
} SPC_SERIALIZED_OBJECT,*PSPC_SERIALIZED_OBJECT;

typedef struct SPC_LINK_ {
	DWORD dwLinkChoice;
	union {
		LPWSTR pwszUrl;
		SPC_SERIALIZED_OBJECT Moniker;
		LPWSTR pwszFile;
	};
} SPC_LINK,*PSPC_LINK;

typedef struct _SPC_PE_IMAGE_DATA {
	CRYPT_BIT_BLOB Flags;
	PSPC_LINK pFile;
} SPC_PE_IMAGE_DATA,*PSPC_PE_IMAGE_DATA;

// MinGW32 doesn't know this one either
typedef struct _CRYPT_ATTRIBUTE_TYPE_VALUE_REDEF {
	LPSTR            pszObjId;
	CRYPT_OBJID_BLOB Value;
} CRYPT_ATTRIBUTE_TYPE_VALUE_REDEF;

typedef struct SIP_INDIRECT_DATA_ {
  CRYPT_ATTRIBUTE_TYPE_VALUE_REDEF Data;
  CRYPT_ALGORITHM_IDENTIFIER       DigestAlgorithm;
  CRYPT_HASH_BLOB                  Digest;
} SIP_INDIRECT_DATA, *PSIP_INDIRECT_DATA;

typedef struct CRYPTCATSTORE_ {
	DWORD      cbStruct;
	DWORD      dwPublicVersion;
	LPWSTR     pwszP7File;
	HCRYPTPROV hProv;
	DWORD      dwEncodingType;
	DWORD      fdwStoreFlags;
	HANDLE     hReserved;
	HANDLE     hAttrs;
	HCRYPTMSG  hCryptMsg;
	HANDLE     hSorted;
} CRYPTCATSTORE;

typedef struct CRYPTCATMEMBER_ {
	DWORD              cbStruct;
	LPWSTR             pwszReferenceTag;
	LPWSTR             pwszFileName;
	GUID               gSubjectType;
	DWORD              fdwMemberFlags;
	PSIP_INDIRECT_DATA pIndirectData;
	DWORD              dwCertVersion;
	DWORD              dwReserved;
	HANDLE             hReserved;
	CRYPT_ATTR_BLOB    sEncodedIndirectData;
	CRYPT_ATTR_BLOB    sEncodedMemberInfo;
} CRYPTCATMEMBER;

typedef struct CRYPTCATATTRIBUTE_ {
	DWORD  cbStruct;
	LPWSTR pwszReferenceTag;
	DWORD  dwAttrTypeAndAction;
	DWORD  cbValue;
	BYTE   *pbValue;
	DWORD  dwReserved;
} CRYPTCATATTRIBUTE;

typedef HANDLE (WINAPI *CryptCATOpen_t)(
	LPWSTR pwszFileName,
	DWORD fdwOpenFlags,
	ULONG_PTR hProv,
	DWORD dwPublicVersion,
	DWORD dwEncodingType
);

typedef BOOL (WINAPI *CryptCATClose_t)(
	HANDLE hCatalog
);

typedef CRYPTCATSTORE* (WINAPI *CryptCATStoreFromHandle_t)(
	HANDLE hCatalog
);

typedef CRYPTCATATTRIBUTE* (WINAPI *CryptCATEnumerateCatAttr_t)(
	HANDLE hCatalog,
	CRYPTCATATTRIBUTE *pPrevAttr
);

typedef CRYPTCATATTRIBUTE* (WINAPI *CryptCATPutCatAttrInfo_t)(
	HANDLE hCatalog,
	LPWSTR pwszReferenceTag,
	DWORD dwAttrTypeAndAction,
	DWORD cbData,
	BYTE *pbData
);

typedef CRYPTCATMEMBER* (WINAPI *CryptCATEnumerateMember_t)(
	HANDLE hCatalog,
	CRYPTCATMEMBER *pPrevMember
);

typedef CRYPTCATMEMBER* (WINAPI *CryptCATPutMemberInfo_t)(
	HANDLE hCatalog,
	LPWSTR pwszFileName,
	LPWSTR pwszReferenceTag,
	GUID *pgSubjectType,
	DWORD dwCertVersion,
	DWORD cbSIPIndirectData,
	BYTE *pbSIPIndirectData
);

typedef CRYPTCATATTRIBUTE* (WINAPI *CryptCATEnumerateAttr_t)(
	HANDLE hCatalog,
	CRYPTCATMEMBER *pCatMember,
	CRYPTCATATTRIBUTE *pPrevAttr
);

typedef CRYPTCATATTRIBUTE* (WINAPI *CryptCATPutAttrInfo_t)(
	HANDLE hCatalog,
	CRYPTCATMEMBER *pCatMember,
	LPWSTR pwszReferenceTag,
	DWORD dwAttrTypeAndAction,
	DWORD cbData,
	BYTE *pbData
);

typedef BOOL (WINAPI *CryptCATPersistStore_t)(
	HANDLE hCatalog
);

typedef BOOL (WINAPI *CryptCATAdminCalcHashFromFileHandle_t)(
	HANDLE hFile,
	DWORD *pcbHash,
	BYTE *pbHash,
	DWORD dwFlags
);

typedef BOOL (WINAPI *CryptCATAdminAcquireContext2_t)(
	HANDLE *phCatAdmin,
	const GUID *pgSubsystem,
	LPCWSTR pwszHashAlgorithm,
	void *pStrongHashPolicy,
	DWORD dwFlags
);

typedef BOOL (WINAPI *CryptCATAdminCalcHashFromFileHandle2_t)(
	HANDLE hCatAdmin,
	HANDLE hFile,
	DWORD *pcbHash,
	BYTE *pbHash,
	DWORD dwFlags
);

typedef BOOL (WINAPI *CryptCATAdminReleaseContext_t)(
	HANDLE hCatAdmin,
	DWORD dwFlags
);

extern char *wdi_windows_error_str(uint32_t retval);
extern int nWindowsVersion;
extern void GetWindowsVersion(void);

/*
 * FormatMessage does not handle PKI errors
 */
char* winpki_error_str(uint32_t retval)
{
	static char error_string[64];
	uint32_t error_code = retval ? retval : GetLastError();

	if (error_code == 0x800706D9)
		return "This system is missing required cryptographic services.";
	if (error_code == 0x80070020)
		return "Sharing violation - Some data handles to this file are still open.";

	if ((error_code >> 16) != 0x8009)
		return wdi_windows_error_str(error_code);

	switch (error_code) {
	case NTE_BAD_UID:
		return "Bad UID.";
	case NTE_BAD_KEYSET:
		return "Keyset does not exist.";
	case NTE_KEYSET_ENTRY_BAD:
		return "Keyset as registered is invalid.";
	case NTE_BAD_FLAGS:
		return "Invalid flags specified.";
	case NTE_BAD_KEYSET_PARAM:
		return "The Keyset parameter is invalid.";
	case NTE_BAD_PROV_TYPE:
		return "Invalid provider type specified.";
	case NTE_EXISTS:
		return "Object already exists.";
	case NTE_BAD_SIGNATURE:
		return "Invalid Signature.";
	case NTE_PROVIDER_DLL_FAIL:
		return "Provider DLL failed to initialize correctly.";
	case NTE_SIGNATURE_FILE_BAD:
		return "The digital signature file is corrupt.";
	case NTE_PROV_DLL_NOT_FOUND:
		return "Provider DLL could not be found.";
	case NTE_KEYSET_NOT_DEF:
		return "The keyset is not defined.";
	case NTE_NO_MEMORY:
		return "Insufficient memory available for the operation.";
	case CRYPT_E_MSG_ERROR:
		return "An error occurred while performing an operation on a cryptographic message.";
	case CRYPT_E_UNKNOWN_ALGO:
		return "Unknown cryptographic algorithm.";
	case CRYPT_E_INVALID_MSG_TYPE:
		return "Invalid cryptographic message type.";
	case CRYPT_E_HASH_VALUE:
		return "The hash value is not correct";
	case CRYPT_E_ISSUER_SERIALNUMBER:
		return "Invalid issuer and/or serial number.";
	case CRYPT_E_BAD_LEN:
		return "The length specified for the output data was insufficient.";
	case CRYPT_E_BAD_ENCODE:
		return "An error occurred during encode or decode operation.";
	case CRYPT_E_FILE_ERROR:
		return "An error occurred while reading or writing to a file.";
	case CRYPT_E_NOT_FOUND:
		return "Cannot find object or property.";
	case CRYPT_E_EXISTS:
		return "The object or property already exists.";
	case CRYPT_E_NO_PROVIDER:
		return "No provider was specified for the store or object.";
	case CRYPT_E_DELETED_PREV:
		return "The previous certificate or CRL context was deleted.";
	case CRYPT_E_NO_MATCH:
		return "Cannot find the requested object.";
	case CRYPT_E_UNEXPECTED_MSG_TYPE:
		return "The certificate does not have a property that references a private key.";
	case CRYPT_E_NO_KEY_PROPERTY:
		return "Cannot find the private key to use for decryption.";
	case CRYPT_E_NO_DECRYPT_CERT:
		return "Cannot find the certificate to use for decryption.";
	case CRYPT_E_BAD_MSG:
		return "Not a cryptographic message.";
	case CRYPT_E_NO_SIGNER:
		return "The signed cryptographic message does not have a signer for the specified signer index.";
	case CRYPT_E_REVOKED:
		return "The certificate is revoked.";
	case CRYPT_E_NO_REVOCATION_DLL:
		return "No Dll or exported function was found to verify revocation.";
	case CRYPT_E_NO_REVOCATION_CHECK:
		return "The revocation function was unable to check revocation for the certificate.";
	case CRYPT_E_REVOCATION_OFFLINE:
		return "The revocation function was unable to check revocation because the revocation server was offline.";
	case CRYPT_E_NOT_IN_REVOCATION_DATABASE:
		return "The certificate is not in the revocation server's database.";
	case CRYPT_E_INVALID_NUMERIC_STRING:
	case CRYPT_E_INVALID_PRINTABLE_STRING:
	case CRYPT_E_INVALID_IA5_STRING:
	case CRYPT_E_INVALID_X500_STRING:
	case CRYPT_E_NOT_CHAR_STRING:
		return "Invalid string.";
	case CRYPT_E_SECURITY_SETTINGS:
		return "The cryptographic operation failed due to a local security option setting.";
	case CRYPT_E_NO_VERIFY_USAGE_CHECK:
		return "The called function was unable to do a usage check on the subject.";
	case CRYPT_E_VERIFY_USAGE_OFFLINE:
		return "Since the server was offline, the called function was unable to complete the usage check.";
	case CRYPT_E_NO_TRUSTED_SIGNER:
		return "None of the signers of the cryptographic message or certificate trust list is trusted.";
	default:
		static_sprintf(error_string, "Unknown PKI error 0x%08X", error_code);
		return error_string;
	}
}

/*
 * Convert an UTF8 string to UTF-16 (allocate returned string)
 * Return NULL on error
 */
static __inline LPWSTR UTF8toWCHAR(LPCSTR szStr)
{
	int size = 0;
	LPWSTR wszStr = NULL;

	// Find out the size we need to allocate for our converted string
	size = MultiByteToWideChar(CP_UTF8, 0, szStr, -1, NULL, 0);
	if (size <= 1)	// An empty string would be size 1
		return NULL;

	if ((wszStr = (wchar_t*)calloc(size, sizeof(wchar_t))) == NULL)
		return NULL;
	if (MultiByteToWideChar(CP_UTF8, 0, szStr, -1, wszStr, size) != size) {
		free(wszStr);
		return NULL;
	}
	return wszStr;
}

/*
 * Parts of the following functions are based on:
 * http://blogs.msdn.com/b/alejacma/archive/2009/03/16/how-to-create-a-self-signed-certificate-with-cryptoapi-c.aspx
 * http://blogs.msdn.com/b/alejacma/archive/2008/12/11/how-to-sign-exe-files-with-an-authenticode-certificate-part-2.aspx
 * http://www.jensign.com/hash/index.html
 */

/* Exact DER equality is the only safe identity for cleanup. A subject can be
 * shared with an unrelated certificate and must never be used as a delete key.
 * Do not rely on a store's duplicate-certificate semantics here: compare the
 * encoded certificate bytes ourselves before deleting anything. */
static BOOL CertDerEquals(PCCERT_CONTEXT left, PCCERT_CONTEXT right)
{
	return (left != NULL) && (right != NULL) &&
		(left->cbCertEncoded == right->cbCertEncoded) &&
		(left->cbCertEncoded != 0) &&
		(memcmp(left->pbCertEncoded, right->pbCertEncoded,
			left->cbCertEncoded) == 0);
}

static BOOL CertPropertyIsAbsent(PCCERT_CONTEXT pCertContext, DWORD propertyId)
{
	DWORD size = 0;

	SetLastError(ERROR_SUCCESS);
	if (CertGetCertificateContextProperty(pCertContext, propertyId, NULL, &size))
		return FALSE;
	return GetLastError() == CRYPT_E_NOT_FOUND;
}

static BOOL CertIsPublicOnly(PCCERT_CONTEXT pCertContext)
{
	return CertPropertyIsAbsent(pCertContext, CERT_KEY_PROV_HANDLE_PROP_ID) &&
		CertPropertyIsAbsent(pCertContext, CERT_KEY_PROV_INFO_PROP_ID) &&
		CertPropertyIsAbsent(pCertContext, CERT_KEY_CONTEXT_PROP_ID) &&
		CertPropertyIsAbsent(pCertContext, CERT_NCRYPT_KEY_HANDLE_PROP_ID);
}

static BOOL CertIsAbsentInStoreExact(PCCERT_CONTEXT pCertContext, LPCSTR szStoreName)
{
	HCERTSTORE hSystemStore = NULL;
	PCCERT_CONTEXT pFound = NULL;
	BOOL r = FALSE;
	DWORD error;

	hSystemStore = CertOpenStore(CERT_STORE_PROV_SYSTEM_A,
		X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
		CERT_SYSTEM_STORE_LOCAL_MACHINE, szStoreName);
	if (hSystemStore == NULL)
		goto out;

	SetLastError(ERROR_SUCCESS);
	while ((pFound = CertEnumCertificatesInStore(hSystemStore, pFound)) != NULL) {
		if (CertDerEquals(pFound, pCertContext))
			goto out;
	}
	error = GetLastError();
	r = (error == CRYPT_E_NOT_FOUND);
	if (!r)
		wdi_warn("Could not prove exact certificate absence in '%s': %s",
			szStoreName, winpki_error_str(0));

out:
	if (pFound != NULL)
		CertFreeCertificateContext(pFound);
	if (hSystemStore != NULL)
		CertCloseStore(hSystemStore, 0);
	return r;
}

static BOOL CertExistsPublicOnlyInStoreExact(PCCERT_CONTEXT pCertContext, LPCSTR szStoreName)
{
	HCERTSTORE hSystemStore = NULL;
	PCCERT_CONTEXT pFound = NULL;
	BOOL r = FALSE;

	hSystemStore = CertOpenStore(CERT_STORE_PROV_SYSTEM_A,
		X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
		CERT_SYSTEM_STORE_LOCAL_MACHINE, szStoreName);
	if (hSystemStore == NULL)
		goto out;
	while ((pFound = CertEnumCertificatesInStore(hSystemStore, pFound)) != NULL) {
		if (CertDerEquals(pFound, pCertContext)) {
			r = CertIsPublicOnly(pFound);
			break;
		}
	}

out:
	if (pFound != NULL)
		CertFreeCertificateContext(pFound);
	if (hSystemStore != NULL)
		CertCloseStore(hSystemStore, 0);
	return r;
}

static BOOL RemoveCertFromStoreExact(PCCERT_CONTEXT pCertContext, LPCSTR szStoreName)
{
	HCERTSTORE hSystemStore = NULL;
	PCCERT_CONTEXT pFound = NULL;
	BOOL r = FALSE;

	hSystemStore = CertOpenStore(CERT_STORE_PROV_SYSTEM_A,
		X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
		CERT_SYSTEM_STORE_LOCAL_MACHINE, szStoreName);
	if (hSystemStore == NULL) {
		wdi_warn("Failed to open system store '%s' for exact cleanup: %s",
			szStoreName, winpki_error_str(0));
		goto out;
	}

	for (;;) {
		DWORD error;

		SetLastError(ERROR_SUCCESS);
		while ((pFound = CertEnumCertificatesInStore(hSystemStore, pFound)) != NULL) {
			if (CertDerEquals(pFound, pCertContext))
				break;
		}
		if (pFound == NULL) {
			error = GetLastError();
				r = (error == CRYPT_E_NOT_FOUND);
			if (!r)
				wdi_warn("Could not enumerate system store '%s' during exact cleanup: %s",
					szStoreName, winpki_error_str(0));
			break;
		}
		/* CertDeleteCertificateFromStore frees pFound even when it fails. */
		if (!CertDeleteCertificateFromStore(pFound)) {
			pFound = NULL;
			wdi_warn("Failed to delete the exact certificate from '%s': %s",
				szStoreName, winpki_error_str(0));
			goto out;
		}
		pFound = NULL;
		/* Restart from the beginning because deletion invalidated the context.
		 * This also removes an accidental duplicate of the exact DER without
		 * ever widening the identity to subject or issuer/serial. */
	}

out:
	if (pFound != NULL)
		CertFreeCertificateContext(pFound);
	if (hSystemStore != NULL)
		CertCloseStore(hSystemStore, 0);
	return r;
}

static BOOL AddCertToStore(PCCERT_CONTEXT pCertContext, LPCSTR szStoreName, BOOL *pAdded)
{
	HCERTSTORE hSystemStore = NULL;
	CRYPT_DATA_BLOB friendlyName = { sizeof(L"KSX one-time WinUSB publisher"),
		(BYTE*)L"KSX one-time WinUSB publisher" };
	BOOL r = FALSE;

	if (pAdded == NULL)
		return FALSE;
	*pAdded = FALSE;
	if (!CertIsPublicOnly(pCertContext)) {
		wdi_warn("Refusing to trust a certificate that advertises a private key");
		return FALSE;
	}

	hSystemStore = CertOpenStore(CERT_STORE_PROV_SYSTEM_A,
		X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
		CERT_SYSTEM_STORE_LOCAL_MACHINE, szStoreName);
	if (hSystemStore == NULL) {
		wdi_warn("Failed to open system store '%s': %s", szStoreName, winpki_error_str(0));
		goto out;
	}
	if (!CertSetCertificateContextProperty(pCertContext,
		CERT_FRIENDLY_NAME_PROP_ID, 0, &friendlyName)) {
		wdi_warn("Could not set certificate friendly name: %s", winpki_error_str(0));
		goto out;
	}
	if (!CertAddCertificateContextToStore(hSystemStore, pCertContext,
		CERT_STORE_ADD_NEW, NULL)) {
		wdi_warn("Failed to add certificate to system store '%s': %s",
			szStoreName, winpki_error_str(0));
		goto out;
	}
	*pAdded = TRUE;
	r = CertExistsPublicOnlyInStoreExact(pCertContext, szStoreName);
	if (!r)
		wdi_warn("Exact public-only certificate postcondition failed for '%s'", szStoreName);

out:
	if (hSystemStore != NULL)
		CertCloseStore(hSystemStore, 0);
	return r;
}

/*
 * Add certificate data to the TrustedPublisher system store
 * Unless bDisableWarning is set, warn the user before install
 */
BOOL AddCertToTrustedPublisher(BYTE* pbCertData, DWORD dwCertSize, BOOL bDisableWarning, HWND hWnd)
{
	PF_DECL_LOAD_LIBRARY(Crypt32);
	PF_DECL(CertOpenStore);
	PF_DECL(CertCreateCertificateContext);
	PF_DECL(CertFindCertificateInStore);
	PF_DECL(CertAddCertificateContextToStore);
	PF_DECL(CertFreeCertificateContext);
	PF_DECL(CertGetNameStringA);
	PF_DECL(CertCloseStore);
	BOOL r = FALSE;
	int user_input;
	HCERTSTORE hSystemStore = NULL;
	PCCERT_CONTEXT pCertContext = NULL, pStoreCertContext = NULL;
	char org[MAX_PATH], org_unit[MAX_PATH];
	char msg_string[1024];

	PF_INIT_OR_OUT(CertOpenStore, Crypt32);
	PF_INIT_OR_OUT(CertCreateCertificateContext, Crypt32);
	PF_INIT_OR_OUT(CertFindCertificateInStore, Crypt32);
	PF_INIT_OR_OUT(CertAddCertificateContextToStore, Crypt32);
	PF_INIT_OR_OUT(CertFreeCertificateContext, Crypt32);
	PF_INIT_OR_OUT(CertGetNameStringA, Crypt32);
	PF_INIT_OR_OUT(CertCloseStore, Crypt32);

	hSystemStore = pfCertOpenStore(CERT_STORE_PROV_SYSTEM_A, X509_ASN_ENCODING,
		0, CERT_SYSTEM_STORE_LOCAL_MACHINE, "TrustedPublisher");

	if (hSystemStore == NULL) {
		wdi_warn("Unable to open system store: %s", winpki_error_str(0));
		goto out;
	}

	/* Check whether certificate already exists
	 * We have to do this manually, so that we can produce a warning to the user
	 * before any certificate is added to the store (first time or update)
	 */
	pCertContext = pfCertCreateCertificateContext(X509_ASN_ENCODING, pbCertData, dwCertSize);

	if (pCertContext == NULL) {
		wdi_warn("Could not create context for certificate: %s", winpki_error_str(0));
		pfCertCloseStore(hSystemStore, 0);
		goto out;
	}

	pStoreCertContext = pfCertFindCertificateInStore(hSystemStore, X509_ASN_ENCODING, 0,
		CERT_FIND_EXISTING, (const void*)pCertContext, NULL);
	if (pStoreCertContext == NULL) {
		user_input = IDOK;
		if (!bDisableWarning) {
			org[0] = 0; org_unit[0] = 0;
			pfCertGetNameStringA(pCertContext, CERT_NAME_ATTR_TYPE, 0, szOID_ORGANIZATION_NAME, org, sizeof(org));
			pfCertGetNameStringA(pCertContext, CERT_NAME_ATTR_TYPE, 0, szOID_ORGANIZATIONAL_UNIT_NAME, org_unit, sizeof(org_unit));
			static_sprintf(msg_string, "Warning: this software is about to install the following organization\n"
				"as a Trusted Publisher on your system:\n\n '%s%s%s%s'\n\n"
				"This will allow this Publisher to run software with elevated privileges,\n"
				"as well as install driver packages, without further security notices.\n\n"
				"If this is not what you want, you can cancel this operation now.", org,
				(org_unit[0] != 0)?" (":"", org_unit, (org_unit[0] != 0)?")":"");
				user_input = MessageBoxA(hWnd, msg_string,
					"Warning: Trusted Certificate installation", MB_OKCANCEL | MB_ICONWARNING);
		}
		if (user_input != IDOK) {
			wdi_info("Operation cancelled by the user");
		} else {
			if (!pfCertAddCertificateContextToStore(hSystemStore, pCertContext, CERT_STORE_ADD_NEWER, NULL)) {
				wdi_warn("Could not add certificate: %s", winpki_error_str(0));
			} else {
				r = TRUE;
			}
		}
	} else {
		r = TRUE;	// Cert already exists
	}

out:
	if (pCertContext != NULL)
		pfCertFreeCertificateContext(pCertContext);
	if (pStoreCertContext != NULL)
		pfCertFreeCertificateContext(pStoreCertContext);
	if (hSystemStore)
		pfCertCloseStore(hSystemStore, 0);
	PF_FREE_LIBRARY(Crypt32);
	return r;
}

static BOOL GenerateKeyContainerName(LPWSTR wszKeyContainer, size_t cchKeyContainer)
{
	BYTE random[16];
	NTSTATUS status;
	int written;

	if ((wszKeyContainer == NULL) || (cchKeyContainer < KSX_KEY_CONTAINER_CHARS))
		return FALSE;
	status = BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG);
	if (status < 0) {
		wdi_warn("Could not obtain system random bytes for a key container (0x%08X)", status);
		return FALSE;
	}
	written = swprintf_s(wszKeyContainer, cchKeyContainer,
		L"KSX-libwdi-%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X",
		random[0], random[1], random[2], random[3], random[4], random[5], random[6], random[7],
		random[8], random[9], random[10], random[11], random[12], random[13], random[14], random[15]);
	SecureZeroMemory(random, sizeof(random));
	return (written > 0) && ((size_t)written < cchKeyContainer);
}

static BOOL GetRelativeValidity(LPSYSTEMTIME pStartTime, LPSYSTEMTIME pEndTime)
{
	FILETIME now;
	ULARGE_INTEGER value;
	const ULONGLONG ticksPerSecond = 10000000ULL;
	const ULONGLONG ticksPerDay = 24ULL * 60ULL * 60ULL * ticksPerSecond;
	const ULONGLONG skew = KSX_CERT_START_SKEW_MINUTES * 60ULL * ticksPerSecond;
	const ULONGLONG validity = KSX_CERT_VALIDITY_DAYS * ticksPerDay;

	GetSystemTimeAsFileTime(&now);
	value.LowPart = now.dwLowDateTime;
	value.HighPart = now.dwHighDateTime;
	if (value.QuadPart <= skew || value.QuadPart > (ULLONG_MAX - validity))
		return FALSE;
	value.QuadPart -= skew;
	now.dwLowDateTime = value.LowPart;
	now.dwHighDateTime = value.HighPart;
	if (!FileTimeToSystemTime(&now, pStartTime))
		return FALSE;
	value.QuadPart += skew + validity;
	now.dwLowDateTime = value.LowPart;
	now.dwHighDateTime = value.HighPart;
	return FileTimeToSystemTime(&now, pEndTime);
}

static BOOL DeleteKeyContainerAndVerify(LPCWSTR wszKeyContainer, BOOL allowAlreadyAbsent)
{
	HCRYPTPROV deleted = 0;
	HCRYPTPROV probe = 0;
	DWORD error;

	if ((wszKeyContainer == NULL) || (wszKeyContainer[0] == 0))
		return FALSE;
	if (!CryptAcquireContextW(&deleted, wszKeyContainer, MS_ENH_RSA_AES_PROV_W, PROV_RSA_AES,
		CRYPT_MACHINE_KEYSET | CRYPT_SILENT | CRYPT_DELETEKEYSET)) {
		error = GetLastError();
		if (!allowAlreadyAbsent || (error != NTE_BAD_KEYSET)) {
			wdi_warn("Failed to delete the exact one-time private-key container: %s",
				winpki_error_str(0));
			return FALSE;
		}
	}
	/* CRYPT_DELETEKEYSET leaves the output handle undefined; do not release it. */
	SetLastError(ERROR_SUCCESS);
	if (CryptAcquireContextW(&probe, wszKeyContainer, MS_ENH_RSA_AES_PROV_W, PROV_RSA_AES,
		CRYPT_MACHINE_KEYSET | CRYPT_SILENT)) {
		CryptReleaseContext(probe, 0);
		wdi_warn("Private-key container still opens after deletion");
		return FALSE;
	}
	error = GetLastError();
	if (error != NTE_BAD_KEYSET) {
		wdi_warn("Could not verify private-key container absence: %s", winpki_error_str(0));
		return FALSE;
	}
	return TRUE;
}

/*
 * Create a self signed certificate for code signing. The caller owns the
 * random container name so it can prove destruction after signing.
 */
static PCCERT_CONTEXT CreateSelfSignedCert(LPCSTR szCertSubject,
	LPWSTR wszKeyContainer, size_t cchKeyContainer, BOOL *pContainerCreated)
{
	PF_DECL_LOAD_LIBRARY(Crypt32);
	PF_DECL(CryptEncodeObject);
	PF_DECL(CertStrToNameA);
	PF_DECL(CertCreateSelfSignCertificate);
	PF_DECL(CertFreeCertificateContext);

	DWORD dwSize = 0;
	HCRYPTPROV hCSP = 0;
	HCRYPTKEY hKey = 0;
	PCCERT_CONTEXT pCertContext = NULL;
	CERT_NAME_BLOB SubjectIssuerBlob = {0, NULL};
	CRYPT_KEY_PROV_INFO KeyProvInfo;
	CRYPT_ALGORITHM_IDENTIFIER SignatureAlgorithm;
	LPBYTE pbEnhKeyUsage = NULL, pbAltNameInfo = NULL, pbCPSNotice = NULL, pbPolicyInfo = NULL;
	SYSTEMTIME sStartDate = { 0 }, sExpirationDate = { 0 };
	CERT_EXTENSION certExtension[3];
	CERT_EXTENSIONS_ARRAY certExtensionsArray;
	// Code Signing Enhanced Key Usage
	LPSTR szCertPolicyElementId = "1.3.6.1.5.5.7.3.3"; // szOID_PKIX_KP_CODE_SIGNING;
	CERT_ENHKEY_USAGE certEnhKeyUsage = { 1, &szCertPolicyElementId };
	// Abuse Alt Name to insert ourselves in the e-mail field
	CERT_ALT_NAME_ENTRY certAltNameEntry = { CERT_ALT_NAME_RFC822_NAME,
		{ (PCERT_OTHER_NAME)L"Created by libwdi (http://libwdi.akeo.ie)" } };
	CERT_ALT_NAME_INFO certAltNameInfo = { 1, &certAltNameEntry };
	// Certificate Policies
	CERT_POLICY_QUALIFIER_INFO_REDEF certPolicyQualifier;
	CERT_POLICY_INFO_REDEF certPolicyInfo = { "1.3.6.1.5.5.7.2.1", 1, &certPolicyQualifier };
	CERT_POLICIES_INFO_ARRAY certPolicyInfoArray = { 1, &certPolicyInfo };
	CHAR szCPSName[] = "http://libwdi-cps.akeo.ie";
	CERT_NAME_VALUE certCPSValue;
	int attempt;
	DWORD keyParameter = 0, keyParameterSize;

	if (pContainerCreated == NULL)
		return NULL;
	*pContainerCreated = FALSE;

	PF_INIT_OR_OUT(CryptEncodeObject, Crypt32);
	PF_INIT_OR_OUT(CertStrToNameA, Crypt32);
	PF_INIT_OR_OUT(CertCreateSelfSignCertificate, Crypt32);
	PF_INIT_OR_OUT(CertFreeCertificateContext, Crypt32);
	if (!GetRelativeValidity(&sStartDate, &sExpirationDate)) {
		wdi_warn("Could not create relative certificate validity dates");
		goto out;
	}

	// Set Enhanced Key Usage extension to Code Signing only
	if ( (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_ENHANCED_KEY_USAGE, (LPVOID)&certEnhKeyUsage, NULL, &dwSize))
	  || ((pbEnhKeyUsage = (BYTE*)malloc(dwSize)) == NULL)
	  || (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_ENHANCED_KEY_USAGE, (LPVOID)&certEnhKeyUsage, pbEnhKeyUsage, &dwSize)) ) {
		wdi_warn("Could not setup EKU for code signing: %s", winpki_error_str(0));
		goto out;
	}
	certExtension[0].pszObjId = szOID_ENHANCED_KEY_USAGE;
	certExtension[0].fCritical = TRUE;		// only allow code signing
	certExtension[0].Value.cbData = dwSize;
	certExtension[0].Value.pbData = pbEnhKeyUsage;

	// Set Alt Name parameter
	if ( (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_ALTERNATE_NAME, (LPVOID)&certAltNameInfo, NULL, &dwSize))
	  || ((pbAltNameInfo = (BYTE*)malloc(dwSize)) == NULL)
	  || (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_ALTERNATE_NAME, (LPVOID)&certAltNameInfo, pbAltNameInfo, &dwSize)) ) {
		wdi_warn("Could not set Alt Name: %s", winpki_error_str(0));
		goto out;
	}
	certExtension[1].pszObjId = szOID_SUBJECT_ALT_NAME;
	certExtension[1].fCritical = FALSE;
	certExtension[1].Value.cbData = dwSize;
	certExtension[1].Value.pbData = pbAltNameInfo;

	// Set the CPS Certificate Policies field - this enables the "Issuer Statement" button on the cert
	certCPSValue.dwValueType = CERT_RDN_IA5_STRING;
	certCPSValue.Value.cbData = sizeof(szCPSName);
	certCPSValue.Value.pbData = (BYTE*)szCPSName;
	if ( (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_NAME_VALUE, (LPVOID)&certCPSValue, NULL, &dwSize))
		|| ((pbCPSNotice = (BYTE*)malloc(dwSize)) == NULL)
		|| (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_NAME_VALUE, (LPVOID)&certCPSValue, pbCPSNotice, &dwSize)) ) {
		wdi_warn("Could not setup CPS: %s", winpki_error_str(0));
		goto out;
	}

	certPolicyQualifier.pszPolicyQualifierId = szOID_PKIX_POLICY_QUALIFIER_CPS;
	certPolicyQualifier.Qualifier.cbData = dwSize;
	certPolicyQualifier.Qualifier.pbData = pbCPSNotice;
	if ( (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_CERT_POLICIES, (LPVOID)&certPolicyInfoArray, NULL, &dwSize))
		|| ((pbPolicyInfo = (BYTE*)malloc(dwSize)) == NULL)
		|| (!pfCryptEncodeObject(X509_ASN_ENCODING, X509_CERT_POLICIES, (LPVOID)&certPolicyInfoArray, pbPolicyInfo, &dwSize)) ) {
		wdi_warn("Could not setup Certificate Policies: %s", winpki_error_str(0));
		goto out;
	}
	certExtension[2].pszObjId = szOID_CERT_POLICIES;
	certExtension[2].fCritical = FALSE;
	certExtension[2].Value.cbData = dwSize;
	certExtension[2].Value.pbData = pbPolicyInfo;

	certExtensionsArray.cExtension = ARRAYSIZE(certExtension);
	certExtensionsArray.rgExtension = certExtension;
	wdi_dbg("Set Enhanced Key Usage, URL and CPS");

	/* Never reuse a signing key. A random name plus CRYPT_NEWKEYSET makes a
	 * collision an explicit retry rather than an accidental open. */
	for (attempt = 0; attempt < 4; attempt++) {
		if (!GenerateKeyContainerName(wszKeyContainer, cchKeyContainer))
			goto out;
		if (CryptAcquireContextW(&hCSP, wszKeyContainer, MS_ENH_RSA_AES_PROV_W, PROV_RSA_AES,
			CRYPT_NEWKEYSET | CRYPT_MACHINE_KEYSET | CRYPT_SILENT)) {
			*pContainerCreated = TRUE;
			break;
		}
		if (GetLastError() != NTE_EXISTS)
			break;
	}
	if (hCSP == 0) {
		wdi_warn("Could not obtain a key container: %s (0x%08X)", winpki_error_str(0), GetLastError());
		goto out;
	}
	wdi_dbg("Created a fresh random key container");

	// Generate key pair using RSA 4096
	// (Key_size <<16) because key size is in upper 16 bits
	if (!CryptGenKey(hCSP, AT_SIGNATURE, (4096U<<16), &hKey)) {
		wdi_dbg("Could not generate keypair: %s", winpki_error_str(0));
		goto out;
	}
	keyParameterSize = sizeof(keyParameter);
	if (!CryptGetKeyParam(hKey, KP_KEYLEN, (BYTE*)&keyParameter, &keyParameterSize, 0) ||
		(keyParameter != 4096U)) {
		wdi_warn("Generated signing key did not satisfy the 4096-bit postcondition");
		goto out;
	}
	keyParameter = 0;
	keyParameterSize = sizeof(keyParameter);
	if (!CryptGetKeyParam(hKey, KP_PERMISSIONS, (BYTE*)&keyParameter, &keyParameterSize, 0) ||
		((keyParameter & CRYPT_EXPORT) != 0)) {
		wdi_warn("Generated signing key did not satisfy the non-exportable postcondition");
		goto out;
	}
	wdi_dbg("Generated new keypair...");

	// Set the subject
	if ( (!pfCertStrToNameA(X509_ASN_ENCODING, szCertSubject, CERT_X500_NAME_STR, NULL, NULL, &SubjectIssuerBlob.cbData, NULL))
	  || ((SubjectIssuerBlob.pbData = (BYTE*)malloc(SubjectIssuerBlob.cbData)) == NULL)
	  || (!pfCertStrToNameA(X509_ASN_ENCODING, szCertSubject, CERT_X500_NAME_STR, NULL, SubjectIssuerBlob.pbData, &SubjectIssuerBlob.cbData, NULL)) ) {
		wdi_warn("Could not encode subject name for self signed cert: %s", winpki_error_str(0));
		goto out;
	}

	// Prepare key provider structure for self-signed certificate
	memset(&KeyProvInfo, 0, sizeof(KeyProvInfo));
	KeyProvInfo.pwszContainerName = wszKeyContainer;
	KeyProvInfo.pwszProvName = (LPWSTR)MS_ENH_RSA_AES_PROV_W;
	KeyProvInfo.dwProvType = PROV_RSA_AES;
	KeyProvInfo.dwFlags = CRYPT_MACHINE_KEYSET;
	KeyProvInfo.cProvParam = 0;
	KeyProvInfo.rgProvParam = NULL;
	KeyProvInfo.dwKeySpec = AT_SIGNATURE;

	// Prepare algorithm structure for self-signed certificate
	memset(&SignatureAlgorithm, 0, sizeof(SignatureAlgorithm));

	SignatureAlgorithm.pszObjId = szOID_RSA_SHA256RSA;

	// Create self-signed certificate
	pCertContext = pfCertCreateSelfSignCertificate((ULONG_PTR)hCSP,
		&SubjectIssuerBlob, 0, &KeyProvInfo, &SignatureAlgorithm,
		&sStartDate, &sExpirationDate, &certExtensionsArray);
	if (pCertContext == NULL) {
		wdi_warn("Could not create self signed certificate: %s", winpki_error_str(0));
		goto out;
	}
	wdi_info("Created new self-signed certificate '%s'", szCertSubject);

out:
	free(pbEnhKeyUsage);
	free(pbAltNameInfo);
	free(pbCPSNotice);
	free(pbPolicyInfo);
	free(SubjectIssuerBlob.pbData);
	if (hKey)
		CryptDestroyKey(hKey);
	if (hCSP)
		CryptReleaseContext(hCSP, 0);
	PF_FREE_LIBRARY(Crypt32);
	return pCertContext;
}

/* Destroy and prove absence of the exact provider+container identity before
 * any certificate derived from it can become machine-trusted. */
static BOOL DeletePrivateKey(LPCWSTR wszKeyContainer, BOOL *pDeleteAttempted,
	BOOL *pContainerDeleted)
{
	if ((pDeleteAttempted == NULL) || (pContainerDeleted == NULL))
		return FALSE;
	*pDeleteAttempted = TRUE;
	if (!DeleteKeyContainerAndVerify(wszKeyContainer, FALSE))
		return FALSE;
	*pContainerDeleted = TRUE;
	return TRUE;
}

/*
 * Digitally sign a file and make it system-trusted by:
 * - creating a self signed certificate for code signing
 * - signing the file while the certificate is not trusted
 * - deleting and verifying absence of the private key
 * - adding only the public certificate to Root and TrustedPublisher
 */
BOOL SelfSignFile(LPCSTR szFileName, LPCSTR szCertSubject)
{
	PF_DECL_LOAD_LIBRARY(MSSign32);
	PF_DECL_LOAD_LIBRARY(Crypt32);
	PF_DECL(SignerSignEx);
	PF_DECL(SignerFreeSignerContext);
	PF_DECL(CertCreateCertificateContext);
	PF_DECL(CertFreeCertificateContext);
	PF_DECL(CertCloseStore);

	BOOL r = FALSE;
	BOOL containerCreated = FALSE;
	BOOL deleteAttempted = FALSE;
	BOOL containerDeleted = FALSE;
	BOOL rootAdded = FALSE;
	BOOL publisherAdded = FALSE;
	LPWSTR wszFileName = NULL;
	WCHAR wszKeyContainer[KSX_KEY_CONTAINER_CHARS] = { 0 };
	HRESULT hResult = S_OK;
	PCCERT_CONTEXT pCertContext = NULL;
	PCCERT_CONTEXT pPublicCertContext = NULL;
	DWORD dwIndex;
	SIGNER_FILE_INFO signerFileInfo = { 0 };
	SIGNER_SUBJECT_INFO signerSubjectInfo = { 0 };
	SIGNER_CERT_STORE_INFO signerCertStoreInfo = { 0 };
	SIGNER_CERT signerCert = { 0 };
	SIGNER_SIGNATURE_INFO signerSignatureInfo = { 0 };
	PSIGNER_CONTEXT pSignerContext = NULL;
	CRYPT_ATTRIBUTES_ARRAY cryptAttributesArray;
	CRYPT_ATTRIBUTE cryptAttribute[2];
	CRYPT_INTEGER_BLOB oidSpOpusInfoBlob, oidStatementTypeBlob;
	BYTE pbOidSpOpusInfo[] = SP_OPUS_INFO_DATA;
	BYTE pbOidStatementType[] = STATEMENT_TYPE_DATA;

	PF_INIT_OR_OUT(SignerSignEx, MSSign32);
	PF_INIT_OR_OUT(SignerFreeSignerContext, MSSign32);
	PF_INIT_OR_OUT(CertCreateCertificateContext, Crypt32);
	PF_INIT_OR_OUT(CertFreeCertificateContext, Crypt32);
	PF_INIT_OR_OUT(CertCloseStore, Crypt32);

	pCertContext = CreateSelfSignedCert(szCertSubject,
		wszKeyContainer, ARRAYSIZE(wszKeyContainer), &containerCreated);
	if (pCertContext == NULL) {
		goto out;
	}
	wdi_dbg("Successfully created certificate '%s'", szCertSubject);
	if (!CertIsAbsentInStoreExact(pCertContext, "Root") ||
		!CertIsAbsentInStoreExact(pCertContext, "TrustedPublisher")) {
		wdi_warn("Could not prove the exact one-time certificate absent before signing");
		goto out;
	}

	// Setup SIGNER_FILE_INFO struct
	signerFileInfo.cbSize = sizeof(SIGNER_FILE_INFO);
	wszFileName = UTF8toWCHAR(szFileName);
	if (wszFileName == NULL) {
		wdi_warn("Unable to convert '%s' to UTF16", szFileName);
		goto out;
	}
	signerFileInfo.pwszFileName = wszFileName;
	signerFileInfo.hFile = NULL;

	// Prepare SIGNER_SUBJECT_INFO struct
	signerSubjectInfo.cbSize = sizeof(SIGNER_SUBJECT_INFO);
	dwIndex = 0;
	signerSubjectInfo.pdwIndex = &dwIndex;
	signerSubjectInfo.dwSubjectChoice = SIGNER_SUBJECT_FILE;
	signerSubjectInfo.pSignerFileInfo = &signerFileInfo;

	// Prepare SIGNER_CERT_STORE_INFO struct
	signerCertStoreInfo.cbSize = sizeof(SIGNER_CERT_STORE_INFO);
	signerCertStoreInfo.pSigningCert = pCertContext;
	signerCertStoreInfo.dwCertPolicy = SIGNER_CERT_POLICY_CHAIN;
	signerCertStoreInfo.hCertStore = NULL;

	// Prepare SIGNER_CERT struct
	signerCert.cbSize = sizeof(SIGNER_CERT);
	signerCert.dwCertChoice = SIGNER_CERT_STORE;
	signerCert.pCertStoreInfo = &signerCertStoreInfo;
	signerCert.hwnd = NULL;

	// Prepare the additional Authenticode OIDs
	oidSpOpusInfoBlob.cbData = sizeof(pbOidSpOpusInfo);
	oidSpOpusInfoBlob.pbData = pbOidSpOpusInfo;
	oidStatementTypeBlob.cbData = sizeof(pbOidStatementType);
	oidStatementTypeBlob.pbData = pbOidStatementType;
	cryptAttribute[0].cValue = 1;
	cryptAttribute[0].rgValue = &oidSpOpusInfoBlob;
	cryptAttribute[0].pszObjId = "1.3.6.1.4.1.311.2.1.12"; // SPC_SP_OPUS_INFO_OBJID in wintrust.h
	cryptAttribute[1].cValue = 1;
	cryptAttribute[1].rgValue = &oidStatementTypeBlob;
	cryptAttribute[1].pszObjId = "1.3.6.1.4.1.311.2.1.11"; // SPC_STATEMENT_TYPE_OBJID in wintrust.h
	cryptAttributesArray.cAttr = 2;
	cryptAttributesArray.rgAttr = cryptAttribute;

	// Prepare SIGNER_SIGNATURE_INFO struct
	signerSignatureInfo.cbSize = sizeof(SIGNER_SIGNATURE_INFO);
	signerSignatureInfo.algidHash = CALG_SHA_256;
	signerSignatureInfo.dwAttrChoice = SIGNER_NO_ATTR;
	signerSignatureInfo.pAttrAuthcode = NULL;
	signerSignatureInfo.psAuthenticated = &cryptAttributesArray;
	signerSignatureInfo.psUnauthenticated = NULL;

	// Sign file with cert
	hResult = pfSignerSignEx(0, &signerSubjectInfo, &signerCert, &signerSignatureInfo, NULL, NULL, NULL, NULL, &pSignerContext);
	if (hResult != S_OK) {
		wdi_warn("SignerSignEx failed (0x%08lX): %s", (unsigned long)hResult, winpki_error_str(hResult));
		goto out;
	}
	wdi_info("Successfully signed file '%s' before establishing trust", szFileName);
	if (pSignerContext != NULL) {
		pfSignerFreeSignerContext(pSignerContext);
		pSignerContext = NULL;
	}

	/* This is the security boundary: a certificate may become trusted only
	 * after the non-exportable one-time key is destroyed and absence proved. */
	if (!DeletePrivateKey(wszKeyContainer, &deleteAttempted, &containerDeleted)) {
		wdi_warn("Private-key deletion postcondition failed; refusing certificate trust");
		goto out;
	}
	wdi_info("Deleted and verified absence of the one-time private key");
	pPublicCertContext = pfCertCreateCertificateContext(X509_ASN_ENCODING,
		pCertContext->pbCertEncoded, pCertContext->cbCertEncoded);
	if ((pPublicCertContext == NULL) || !CertIsPublicOnly(pPublicCertContext)) {
		wdi_warn("Could not create a fresh public-only certificate context");
		goto out;
	}

	if (!AddCertToStore(pPublicCertContext, "Root", &rootAdded) ||
		!AddCertToStore(pPublicCertContext, "TrustedPublisher", &publisherAdded) ||
		!CertExistsPublicOnlyInStoreExact(pPublicCertContext, "Root") ||
		!CertExistsPublicOnlyInStoreExact(pPublicCertContext, "TrustedPublisher")) {
		wdi_warn("Certificate trust-store postcondition failed");
		goto out;
	}
	wdi_info("Added the public certificate '%s' to Root and TrustedPublisher", szCertSubject);
	r = TRUE;

	// Clean up
out:
	if (containerCreated && !containerDeleted && (wszKeyContainer[0] != 0)) {
		/* Retry cleanup on every failure path. Even when this succeeds, the
		 * preparation remains failed because the primary postcondition failed. */
		if (!DeleteKeyContainerAndVerify(wszKeyContainer, deleteAttempted))
			wdi_warn("FATAL: could not clean the one-time private-key container");
	}
	if (!r && (pPublicCertContext != NULL)) {
		/* A partially added certificate is removed by exact DER, never by the
		 * caller-controlled subject shared by potentially unrelated certs. */
		if (publisherAdded && !RemoveCertFromStoreExact(pPublicCertContext, "TrustedPublisher"))
			wdi_warn("FATAL: exact TrustedPublisher rollback failed");
		if (rootAdded && !RemoveCertFromStoreExact(pPublicCertContext, "Root"))
			wdi_warn("FATAL: exact Root rollback failed");
	}
	free((void*)wszFileName);
	if (pSignerContext != NULL)
		pfSignerFreeSignerContext(pSignerContext);
	if (pCertContext != NULL)
		pfCertFreeCertificateContext(pCertContext);
	if (pPublicCertContext != NULL)
		pfCertFreeCertificateContext(pPublicCertContext);
	PF_FREE_LIBRARY(MSSign32);
	PF_FREE_LIBRARY(Crypt32);
	return r;
}

/* Open the one catalog member and compute its Windows catalog SHA-256 digest. */
static BOOL CalcHash(BYTE* pbHash, LPCSTR szfilePath)
{
	PF_DECL_LOAD_LIBRARY(WinTrust);
	PF_DECL(CryptCATAdminCalcHashFromFileHandle);
	BOOL r = FALSE;
	HANDLE hFile = INVALID_HANDLE_VALUE;
	DWORD cbHash = SHA1_HASH_LENGTH;
	LPWSTR wszFilePath = NULL;

	PF_INIT_OR_OUT(CryptCATAdminCalcHashFromFileHandle, WinTrust);

	wszFilePath = UTF8toWCHAR(szfilePath);
	if (wszFilePath == NULL)
		goto out;
	hFile = CreateFileW(wszFilePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
	if (hFile == INVALID_HANDLE_VALUE)
		goto out;
	/* KSX: the version-1 API, which needs no admin context and produces the
	 * SHA-1 member digest a version-1 catalogue declares. The SHA-256 pair
	 * (AcquireContext2/CalcHashFromFileHandle2) produced a digest Windows
	 * never looked for, because the catalogue it went into said SHA-1. */
	if (!pfCryptCATAdminCalcHashFromFileHandle(hFile, &cbHash, pbHash, 0) ||
		(cbHash != SHA1_HASH_LENGTH))
		goto out;
	r = TRUE;

out:
	free(wszFilePath);
	if (hFile != INVALID_HANDLE_VALUE)
		CloseHandle(hFile);
	PF_FREE_LIBRARY(WinTrust);
	return r;
}

/*
 * Add a new member to a cat file, containing the hash for the relevant file
 */
static BOOL AddFileHash(HANDLE hCat, LPCSTR szFileName, BYTE* pbFileHash)
{
	const GUID inf_guid = {0xDE351A42, 0x8E59, 0x11D0, {0x8C, 0x47, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE}};
	const GUID pe_guid = {0xC689AAB8, 0x8E78, 0x11D0, {0x8C, 0x47, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE}};
	const BYTE fImageData = 0xA0;		// Flags used for the SPC_PE_IMAGE_DATA "<<<Obsolete>>>" link
	LPCWSTR wszOSAttr = L"2:10.0";

	PF_DECL_LOAD_LIBRARY(WinTrust);
	PF_DECL_LOAD_LIBRARY(Crypt32);
	PF_DECL(CryptCATPutMemberInfo);
	PF_DECL(CryptCATPutAttrInfo);
	PF_DECL(CryptEncodeObject);

	BOOL bPEType = FALSE;
	CRYPTCATMEMBER* pCatMember = NULL;
	SIP_INDIRECT_DATA sSIPData;
	SPC_LINK sSPCLink;
	SPC_PE_IMAGE_DATA sSPCImageData;
	WCHAR wszHash[2*SHA1_HASH_LENGTH+1];
	LPWSTR wszFileName = NULL;
	LPCSTR szExt;
	LPSTR szExtCopy = NULL;
	BYTE pbEncoded[64];
	DWORD cbEncoded;
	int i;
	BOOL r= FALSE;

	PF_INIT_OR_OUT(CryptCATPutMemberInfo, WinTrust);
	PF_INIT_OR_OUT(CryptCATPutAttrInfo, WinTrust);
	PF_INIT_OR_OUT(CryptEncodeObject, Crypt32);

	// Create the required UTF-16 strings
	for (i=0; i<SHA1_HASH_LENGTH; i++) {
		_snwprintf((wchar_t*)(&wszHash[2*i]), 3, L"%02X", pbFileHash[i]);
	}
	wszFileName = UTF8toWCHAR(szFileName);
	if (wszFileName == NULL) {
		goto out;
	}
	_wcslwr(wszFileName);	// All cat filenames seem to be lowercases

	// Set the PE or CAB/INF type according to the extension
	for (szExt = &szFileName[strlen(szFileName)]; (szExt > szFileName) && (*szExt!='.'); szExt--);
	if (szExt == szFileName) {
		wdi_warn("Unhandled file type: '%s' - ignoring", szFileName);
		goto out;
	}
	szExt++;
	szExtCopy = _strdup(szExt);
	if (szExtCopy == NULL)
		goto out;
	_strlwr((char*)szExtCopy);
	if (strcmp(szExtCopy, "inf") == 0) {
		wdi_dbg("'%s': INF type", szFileName);
	} else {
		wdi_warn("KSX catalogs may contain only an INF: '%s'", szFileName);
		goto out;
	}

	// An "<<<Obsolete>>>" Authenticode link must be populated for each entry
	sSPCLink.dwLinkChoice = SPC_FILE_LINK_CHOICE;
	sSPCLink.pwszUrl = L"<<<Obsolete>>>";
	cbEncoded = sizeof(pbEncoded);
	// PE and INF encode the link differently
	if (bPEType) {
		sSPCImageData.Flags.cbData = 1;
		sSPCImageData.Flags.cUnusedBits = 0;
		sSPCImageData.Flags.pbData = (BYTE*)&fImageData;
		sSPCImageData.pFile = &sSPCLink;
		if (!pfCryptEncodeObject(X509_ASN_ENCODING, SPC_PE_IMAGE_DATA_OBJID, &sSPCImageData, pbEncoded, &cbEncoded)) {
			wdi_warn("Unable to encode SPC Image Data: %s", winpki_error_str(0));
			goto out;
		}
	} else {
		if (!pfCryptEncodeObject(X509_ASN_ENCODING, SPC_CAB_DATA_OBJID, &sSPCLink, pbEncoded, &cbEncoded)) {
			wdi_warn("Unable to encode SPC Image Data: %s", winpki_error_str(0));
			goto out;
		}
	}

	// Populate the SHA-1 member digest, matching the version-1 catalogue.
	sSIPData.Data.pszObjId = (bPEType)?SPC_PE_IMAGE_DATA_OBJID:SPC_CAB_DATA_OBJID;
	sSIPData.Data.Value.cbData = cbEncoded;
	sSIPData.Data.Value.pbData = pbEncoded;
	sSIPData.DigestAlgorithm.pszObjId = szOID_OIWSEC_sha1;
	sSIPData.DigestAlgorithm.Parameters.cbData = 0;
	sSIPData.Digest.cbData = SHA1_HASH_LENGTH;
	sSIPData.Digest.pbData = pbFileHash;

	// Create the new member
	if ((pCatMember = pfCryptCATPutMemberInfo(hCat, NULL, wszHash, (GUID*)((bPEType)?&pe_guid:&inf_guid),
		0x200, sizeof(sSIPData), (BYTE*)&sSIPData)) == NULL) {
		wdi_warn("Unable to create cat entry for file '%s': %s", szFileName, winpki_error_str(0));
		goto out;
	}

	// Add the "File" and "OSAttr" attributes to the newly created member
	if ( (pfCryptCATPutAttrInfo(hCat, pCatMember, L"File",
		  CRYPTCAT_ATTR_AUTHENTICATED|CRYPTCAT_ATTR_NAMEASCII|CRYPTCAT_ATTR_DATAASCII,
		  2*((DWORD)wcslen(wszFileName)+1), (BYTE*)wszFileName) == NULL)
	  || (pfCryptCATPutAttrInfo(hCat, pCatMember, L"OSAttr",
		  CRYPTCAT_ATTR_AUTHENTICATED|CRYPTCAT_ATTR_NAMEASCII|CRYPTCAT_ATTR_DATAASCII,
		  2*((DWORD)wcslen(wszOSAttr)+1), (BYTE*)wszOSAttr) == NULL) ) {
		wdi_warn("Unable to create attributes for file '%s': %s", szFileName, winpki_error_str(0));
		goto out;
	}
	r = TRUE;

out:
	free(szExtCopy);
	free(wszFileName);
	PF_FREE_LIBRARY(WinTrust);
	PF_FREE_LIBRARY(Crypt32);
	return r;
}

/*
 * Create a catalog for exactly one named INF in szSearchDir.
 */
BOOL CreateCat(LPCSTR szCatPath, LPCSTR szHWID, LPCSTR szSearchDir, LPCSTR* szFileList, DWORD cFileList)
{
	PF_DECL_LOAD_LIBRARY(WinTrust);
	PF_DECL(CryptCATOpen);
	PF_DECL(CryptCATClose);
	PF_DECL(CryptCATPersistStore);
	PF_DECL(CryptCATStoreFromHandle);
	PF_DECL(CryptCATPutCatAttrInfo);

	HCRYPTPROV hProv = 0;
	HANDLE hCat = INVALID_HANDLE_VALUE;
	BOOL r = FALSE;
	LPWSTR wszCatPath = NULL;
	LPWSTR wszHWID = NULL;
	CHAR szMemberPath[MAX_PATH];
	BYTE pbHash[SHA1_HASH_LENGTH];
	// KSX's distributed provider and INF are Windows 10/11 x64 only.
	LPCWSTR wszOS = L"10_X64";

	PF_INIT_OR_OUT(CryptCATOpen, WinTrust);
	PF_INIT_OR_OUT(CryptCATClose, WinTrust);
	PF_INIT_OR_OUT(CryptCATPersistStore, WinTrust);
	PF_INIT_OR_OUT(CryptCATStoreFromHandle, WinTrust);
	PF_INIT_OR_OUT(CryptCATPutCatAttrInfo, WinTrust);

	if ((cFileList != 1) || (szFileList == NULL) || (szFileList[0] == NULL) ||
		(szFileList[0][0] == 0) || (strpbrk(szFileList[0], "\\/:") != NULL) ||
		(_stricmp(szFileList[0] + (strlen(szFileList[0]) > 4 ? strlen(szFileList[0]) - 4 : 0), ".inf") != 0)) {
		wdi_warn("KSX catalog creation requires exactly one bare INF member");
		goto out;
	}
	if ((strlen(szSearchDir) + strlen(szFileList[0]) + 2) > sizeof(szMemberPath)) {
		wdi_warn("Catalog member path is too long");
		goto out;
	}
	static_sprintf(szMemberPath, "%s\\%s", szSearchDir, szFileList[0]);

	if (!CryptAcquireContextW(&hProv, NULL, MS_ENH_RSA_AES_PROV_W, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) {
		wdi_warn("Unable to acquire crypt context for cat creation");
		goto out;
	}
	wszCatPath = UTF8toWCHAR(szCatPath);
	wszHWID = UTF8toWCHAR(szHWID);
	if ((wszCatPath == NULL) || (wszHWID == NULL))
		goto out;
	_wcslwr(wszHWID);	// Most of the cat strings are converted to lowercase
	/* KSX: version 1, whose declared member algorithm is SHA-1, matching the
	 * SHA-1 tags AddFileHash writes. The catalogue's declaration and its tags
	 * must agree; when they did not, Windows hashed the INF with the algorithm
	 * the catalogue claimed, matched no member, and refused the package with
	 *
	 *   sig: Driver package catalog is valid.
	 *   !!!  sig: Driver package INF file hash is not present in catalog file.
	 *        Error = 0xE000024B  (ERROR_FILE_HASH_NOT_IN_CATALOG)
	 *
	 * which counts as unsigned, which is a prompt, which is why
	 * `pnputil /add-driver` blocked forever on a machine with nobody at it.
	 * Making both sides SHA-256 was tried and Windows still refused it, so
	 * this is upstream's construction: the one Zadig ships and Windows 10/11
	 * accepts. Only the member digest is SHA-1 -- the catalogue is still
	 * signed with the 4096-bit key and a SHA-256 signature. */
	hCat= pfCryptCATOpen(wszCatPath, CRYPTCAT_OPEN_CREATENEW, hProv, 0, 0);
	if (hCat == INVALID_HANDLE_VALUE) {
		wdi_warn("Unable to create file '%s': %s", szCatPath, winpki_error_str(0));
		goto out;
	}

	// Setup the general Cat attributes
	if (pfCryptCATPutCatAttrInfo(hCat, L"HWID1", CRYPTCAT_ATTR_AUTHENTICATED|CRYPTCAT_ATTR_NAMEASCII|CRYPTCAT_ATTR_DATAASCII,
		2*((DWORD)wcslen(wszHWID)+1), (BYTE*)wszHWID) ==  NULL) {
		wdi_warn("Failed to set HWID1 cat attribute: %s", winpki_error_str(0));
		goto out;
	}
	if (pfCryptCATPutCatAttrInfo(hCat, L"OS", CRYPTCAT_ATTR_AUTHENTICATED|CRYPTCAT_ATTR_NAMEASCII|CRYPTCAT_ATTR_DATAASCII,
		2*((DWORD)wcslen(wszOS)+1), (BYTE*)wszOS) == NULL) {
		wdi_warn("Failed to set OS cat attribute: %s", winpki_error_str(0));
		goto out;
	}

	/* There is no recursive search and no ignored member failure: the caller's
	 * just-written canonical INF is the catalog's one and only member. */
	if (!CalcHash(pbHash, szMemberPath) ||
		!AddFileHash(hCat, szFileList[0], pbHash)) {
		wdi_warn("Could not add the exact INF member '%s' to the catalog", szMemberPath);
		goto out;
	}
	// The cat needs to be sorted before being saved
	if (!pfCryptCATPersistStore(hCat)) {
		wdi_warn("Unable to sort file: %s",  winpki_error_str(0));
		goto out;
	}
	wdi_info("Successfully created file '%s'", szCatPath);
	r = TRUE;

out:
	free(wszCatPath);
	free(wszHWID);
	if (hProv)
		(CryptReleaseContext(hProv, 0));
	if (hCat != INVALID_HANDLE_VALUE)
		pfCryptCATClose(hCat);
	PF_FREE_LIBRARY(WinTrust);
	return r;
}
