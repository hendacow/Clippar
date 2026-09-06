//
//  ExpoShim.swift — the SMALLEST possible stand-in for ExpoModulesCore.
//
//  WHY IT EXISTS. The app's impact estimate is produced by native Swift that
//  `import ExpoModulesCore`. That pod is an iOS build product wired to React
//  Native's JSI; it does not build for macOS. Without a stand-in, the only way
//  to observe the app's own impact is to run the app on a phone — which no
//  bench can do, and which is exactly the measurement this project keeps
//  guessing at.
//
//  WHAT IT IS NOT. It does not reimplement, wrap or approximate any detector.
//  The module files (SwingVisionModule.swift, ShotDetectorModule.swift, and
//  their helpers) are compiled BYTE-FOR-BYTE UNMODIFIED — copied, never edited.
//  This file supplies only the DSL and plumbing symbols those files touch. If a
//  module ever reaches for a symbol that is not here, the build FAILS rather
//  than silently running something different from the app.
//
//  FIDELITY. The declaration shapes below are copied from the real
//  expo-modules-core sources in node_modules (ios/Core/Protocols/AnyModule.swift,
//  ios/Core/Modules/Module.swift, ios/Core/Modules/ModuleDefinitionBuilder.swift,
//  ios/Core/Promise.swift). In particular `Module` really is
//  `typealias Module = AnyModule & BaseModule` — that is what lets a module
//  write `public func definition()` with no `override`, and what carries the
//  @ModuleDefinitionBuilder attribute onto the subclass by witness inference.
//  Getting that shape wrong is the difference between compiling the real file
//  and having to edit it.
//
//  HOW THE REAL ENTRY POINT IS REACHED. `AsyncFunction("name") { ... }` stores
//  the closure in ExpoShimRegistry. main.swift calls `module.definition()`
//  (which registers), runs the OnCreate blocks, and then invokes the stored
//  closure with exactly the arguments the JS wrapper passes. So the bench goes
//  THROUGH the module's registered entry point, not around it.
//
import Foundation

// MARK: - Definitions

public protocol AnyDefinition {}
public struct ShimDefinition: AnyDefinition { public init() {} }

public struct ModuleDefinition: AnyDefinition {
  public init() {}
  public init(definitions: [AnyDefinition]) {}
}

@resultBuilder
public struct ModuleDefinitionBuilder {
  public static func buildBlock(_ definitions: AnyDefinition...) -> ModuleDefinition {
    ModuleDefinition(definitions: definitions)
  }
}

// MARK: - Registry

public enum ExpoShimRegistry {
  /// Registered function name -> the module's own closure, type-erased.
  public nonisolated(unsafe) static var functions: [String: Any] = [:]
  /// OnCreate blocks, run once the definition has been built.
  public nonisolated(unsafe) static var onCreate: [() -> Void] = []
  public nonisolated(unsafe) static var events: [String] = []

  public static func reset() { functions = [:]; onCreate = []; events = [] }
  public static func fn<T>(_ name: String, as type: T.Type) -> T? { functions[name] as? T }

  /// Builds the module's definition and runs its OnCreate blocks — what the
  /// Expo runtime does when it constructs a module holder.
  public static func boot<M: AnyModule>(_ module: M) -> M {
    _ = module.definition()
    let blocks = onCreate
    onCreate = []
    for b in blocks { b() }
    return module
  }
}

// MARK: - Module (shape copied from expo-modules-core)

public protocol AnyModule: AnyObject {
  init()
  @ModuleDefinitionBuilder func definition() -> ModuleDefinition
}

open class BaseModule {
  public required init() {}
  public func sendEvent(_ eventName: String, _ body: [String: Any?] = [:]) {}
}

public typealias Module = AnyModule & BaseModule

// MARK: - DSL

public func Name(_ n: String) -> AnyDefinition { ShimDefinition() }
public func Events(_ names: String...) -> AnyDefinition { ExpoShimRegistry.events += names; return ShimDefinition() }
public func Events(_ names: [String]) -> AnyDefinition { ExpoShimRegistry.events += names; return ShimDefinition() }
public func OnCreate(_ body: @escaping () -> Void) -> AnyDefinition {
  ExpoShimRegistry.onCreate.append(body); return ShimDefinition()
}
public func OnDestroy(_ body: @escaping () -> Void) -> AnyDefinition { ShimDefinition() }
public func OnStartObserving(_ body: @escaping () -> Void) -> AnyDefinition { ShimDefinition() }
public func OnStopObserving(_ body: @escaping () -> Void) -> AnyDefinition { ShimDefinition() }
public func Constants(_ b: @escaping () -> [String: Any?]) -> AnyDefinition { ShimDefinition() }
public func Field(_ n: String) -> AnyDefinition { ShimDefinition() }
public func Field<T>(_ n: String, _ v: T) -> AnyDefinition { ShimDefinition() }

// Arity-explicit overloads. Parameter packs would be terser, but an explicit
// overload set gives a readable error the day a module's signature changes.
public func Function<R>(_ n: String, _ b: @escaping () -> R) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func Function<A, R>(_ n: String, _ b: @escaping (A) -> R) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func Function<A, B, R>(_ n: String, _ b: @escaping (A, B) -> R) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }

public func AsyncFunction<A>(_ n: String, _ b: @escaping (A) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B>(_ n: String, _ b: @escaping (A, B) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B, C>(_ n: String, _ b: @escaping (A, B, C) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B, C, D>(_ n: String, _ b: @escaping (A, B, C, D) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B, C, D, E>(_ n: String, _ b: @escaping (A, B, C, D, E) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B, C, D, E, F>(_ n: String, _ b: @escaping (A, B, C, D, E, F) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }
public func AsyncFunction<A, B, C, D, E, F, G>(_ n: String, _ b: @escaping (A, B, C, D, E, F, G) -> Void) -> AnyDefinition { ExpoShimRegistry.functions[n] = b; return ShimDefinition() }

// MARK: - Exception / Promise

open class Exception: Error, CustomStringConvertible {
  public let name: String
  public let reason: String
  public let code: String
  public init(name: String, description: String, code: String = "") {
    self.name = name; self.reason = description; self.code = code.isEmpty ? name : code
  }
  public var description: String { "\(name): \(reason)" }
}

/// A struct with resolver/rejecter closures — the real one's shape. The caller
/// supplies the closures, so the bench sees exactly one settle and nothing else.
public struct Promise {
  public typealias ResolveClosure = (Any?) -> Void
  public typealias RejectClosure = (Exception) -> Void
  public var resolver: ResolveClosure
  public var rejecter: RejectClosure

  public init(resolver: @escaping ResolveClosure, rejecter: @escaping RejectClosure) {
    self.resolver = resolver; self.rejecter = rejecter
  }

  public func resolve(_ value: Any? = nil) { resolver(value) }
  public func reject(_ error: Exception) { rejecter(error) }
  public func reject(_ error: Error) {
    rejecter((error as? Exception) ?? Exception(name: "ERR_UNEXPECTED", description: "\(error)"))
  }
  public func reject(_ code: String, _ description: String) {
    rejecter(Exception(name: code, description: description, code: code))
  }
}

/// Blocking collector: hand `promise` to a module, then `await()` the settle.
public final class ShimPromiseBox {
  private let sem = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var settled = false
  public private(set) var value: Any?
  public private(set) var error: Exception?

  public init() {}

  public var promise: Promise {
    Promise(
      resolver: { v in self.settle { self.value = v } },
      rejecter: { e in self.settle { self.error = e } }
    )
  }

  private func settle(_ apply: () -> Void) {
    lock.lock()
    if settled { lock.unlock(); return }
    settled = true
    apply()
    lock.unlock()
    sem.signal()
  }

  /// Blocks up to `timeout` seconds. Returns false on timeout.
  @discardableResult
  public func await(_ timeout: TimeInterval = 900) -> Bool {
    sem.wait(timeout: .now() + timeout) == .success
  }
}
