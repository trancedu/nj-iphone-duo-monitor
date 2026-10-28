import Foundation
import CoreGraphics
let profile=CommandLine.arguments.dropFirst().first ?? ""
guard CGPreflightScreenCaptureAccess() else { print("unavailable");exit(0) }
guard profile.range(of:"^Duo(256|512|1024)(White|Black)$",options:.regularExpression) != nil else {exit(1)}
let windows=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
let matched=windows.filter{ ($0[kCGWindowOwnerName as String] as? String)=="Safari" && ($0[kCGWindowName as String] as? String)?.hasPrefix(profile+" — ")==true }
guard matched.count==1,let id=matched[0][kCGWindowNumber as String] as? UInt32 else {print("unavailable");exit(0)}
print(id)
