// DtmuxGuard: stops dtmux gently before macOS logs out, restarts or shuts down.
//
// At a reboot every process gets SIGTERM at about the same time, so coding
// agents in dtmux's tabs would die before dtmux could close them the way a
// person does (Ctrl+C) and catch their resume lines. This invisible app is
// asked to quit before that happens (loginwindow asks every app first), and
// holds the logout until `dtmux kill` has finished its full stop: agents
// closed, resume commands and windows written down, tmux ended. Then it lets
// the logout go on. If the logout is cancelled after all, it starts dtmux
// again a minute later.
//
// Built and installed by macos/install.sh; run at login by a LaunchAgent.
// Arguments: <node> <path to bin/dtmux.js>. The environment (DTMUX_*) is
// passed on, so a test instance can be guarded the same way.
import AppKit

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: DtmuxGuard <node> <dtmux.js>\n".data(using: .utf8)!)
  exit(2)
}
let node = args[1]
let dtmux = args[2]
let limit: TimeInterval = 25  // dtmux's own stop gives up after 15 s

func log(_ s: String) {
  print("\(ISO8601DateFormatter().string(from: Date())) \(s)")
  fflush(stdout)
}

func runDtmux(_ op: String, done: @escaping (Int32) -> Void) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: node)
  p.arguments = [dtmux, op]
  p.terminationHandler = { proc in DispatchQueue.main.async { done(proc.terminationStatus) } }
  do { try p.run() } catch {
    log("could not run dtmux \(op): \(error)")
    done(-1)
  }
}

final class Guard: NSObject, NSApplicationDelegate {
  var stopping = false

  func applicationDidFinishLaunching(_ n: Notification) {
    log("watching for logout, restart and shutdown")
    // Posted when the user asks to log out, restart or shut down: start the
    // stop right away, before the apps are even asked to quit.
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(willPowerOff), name: NSWorkspace.willPowerOffNotification, object: nil)
  }

  @objc func willPowerOff(_ n: Notification) { stop(then: nil) }

  // loginwindow asks us to quit: answer once dtmux has stopped.
  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    stop { app.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }

  var waiting: [() -> Void] = []
  var stopped = false  // the stop has finished (or given up)

  func stop(then: (() -> Void)?) {
    if stopped {
      then?()  // already done: answer at once
      return
    }
    if let then { waiting.append(then) }
    if stopping { return }
    stopping = true
    log("logout or shutdown: stopping dtmux gently")
    let finish = { [self] (why: String) in
      if stopped { return }
      stopped = true
      log(why)
      let w = waiting
      waiting = []
      w.forEach { $0() }
      // Still here a minute later: the logout was cancelled. Bring dtmux back.
      DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [self] in
        log("still running: the logout was cancelled; starting dtmux again")
        stopping = false
        stopped = false
        runDtmux("start") { _ in }
      }
    }
    runDtmux("kill") { status in finish("dtmux stopped (exit \(status))") }
    DispatchQueue.main.asyncAfter(deadline: .now() + limit) { finish("dtmux did not stop in \(Int(limit)) s; letting the logout go on") }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // no Dock icon, no menu bar
let delegate = Guard()
app.delegate = delegate
app.run()
