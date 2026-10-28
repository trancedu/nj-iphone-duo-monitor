import Foundation
import Security

// Read/write only this application's local Keychain item. Secrets use stdin/stdout,
// never command arguments. This is an application secret, not a Wallet payment card.
let service = "com.trancedu.iphone-duo.guest-card"
let account = "checkout-card"
let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service, kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false]
func fail(_ status: OSStatus) -> Never {
    FileHandle.standardError.write(Data("keychain_error_\(status)\n".utf8)); exit(1)
}
let operation = CommandLine.arguments.dropFirst().first ?? ""
if operation == "store" {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count < 4096,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          Set(obj.keys) == Set(["number", "expiry", "cvv"]),
          obj.values.allSatisfy({ !$0.isEmpty }) else { fail(errSecParam) }
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "iPhoneDuo Guest checkout card"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(item as CFDictionary, nil)
        if result != errSecSuccess { fail(result) }
    } else if status != errSecSuccess { fail(status) }
    print("stored")
} else if operation == "read" {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status != errSecSuccess { fail(status) }
    guard let data = result as? Data else { fail(errSecDecode) }
    FileHandle.standardOutput.write(data)
} else { fail(errSecParam) }
