# Drag Action Wheel: Phase 0 feasibility probe

**Status: written and compiled, NOT yet run on Windows.** I work on Linux and cannot drag a file out of Windows Explorer,
so none of the questions below is answered yet. This folder exists so you can answer them in about 15 minutes, and so the full
feature is not built on an assumption. If a result below comes out "no", stop and use the fallback listed for it.

## What the probe is
A small separate Tauri app (not part of OrangeFile's build). It has a tray icon, a main window that hides when closed, a global
shortcut you can change, and a pre-created, hidden overlay window (transparent, borderless, always on top, not focusable,
not in the taskbar). The shortcut shows the overlay centred on the pointer, inside the work area of the monitor it is on,
without activating it. The overlay has four test quarters, A–D. It receives the OS drag through the same mechanism the product
would use (wry's `IDropTarget` on the overlay's WebView2), **not** HTML5 drag events. Both Rust and the page log what they see.
Everything is timestamped to `%TEMP%\dragwheel-probe.log` and shown in the main window.

## Run it (Windows 10/11, same prerequisites as OrangeFile: Rust, MSVC build tools, WebView2)
```
cd prototypes\drag-wheel-probe
cargo run
```
Optional: `set PROBE_SHORTCUT=Ctrl+Alt+W` before `cargo run` to start with another shortcut; the main window can also change it
live (type a shortcut, press Register: a conflict shows as an error and is logged).

## The test, step by step
1. Close the main window. Check the tray icon is still there and the process is in Task Manager. *(question 1)*
2. In Explorer, press and **hold** the mouse on a file. While still holding, press **Ctrl+Shift+Space**. *(question 2)*
3. The wheel should appear under the pointer. Explorer's drag image should still be attached to the pointer. *(question 3)*
4. Move onto a quarter (it should turn orange) and release on it. *(questions 4 and 5)*
5. Repeat with Esc instead of releasing on a quarter, and with releasing outside the wheel. *(question 6)*
6. Open `%TEMP%\dragwheel-probe.log` (or tray → Open probe window) and fill in the table.

Read the log like this:
- `SHORTCUT. left_button_down=true …` the shortcut arrived during the drag, and the button really was down.
- `overlay shown … foreground_changed=false focused=Some(false)` it did not take focus.
- `RUST drag ENTER n path(s)` (and `overlay: DRAG ENTER`) the in-progress drag reached the overlay **before** the drop. The product needs
  this to build the action list from the file types.
- `over -> tl/tr/bl/br` hover tracking works, so the hovered action can be highlighted.
- `RUST drag DROP … [paths]` then `DROP on "B": … exists=true dir=… non_ascii=…` the real paths reached Rust and are valid.
- `ESC pressed` / `overlay hidden (…)` the reason each close happened.
- `keydown … reached the overlay` would mean the overlay can see keys. Expect **no** such line: during a drag Escape belongs to
  Explorer's drag loop (it cancels the drag itself). The probe notices Escape by polling the key state while the overlay is visible.

## Results to fill in
| # | Question | Result (yes / no / how it behaved) |
|---|---|---|
| 1 | App stays running with the main window hidden, tray icon present | |
| 2 | Shortcut reaches the app while Explorer is mid-drag (`left_button_down=true`) | |
| 3 | Overlay appears at the pointer; Explorer's drag is **not** cancelled; focus not stolen | |
| 4a | `DRAG ENTER` arrives **without moving the mouse** after the overlay appears | |
| 4b | `DRAG ENTER` arrives after moving the mouse slightly | |
| 4c | `DRAG ENTER` carries the paths (before the drop) | |
| 5 | Drop on a quarter returns the correct paths to Rust | |
| 6a | Esc: wheel closes, drag cancelled, nothing dropped anywhere | |
| 6b | Release outside the wheel: wheel closes, the drop goes where the user released (Explorer's normal behaviour) | |
| 6c | Release on the centre hub: treated as cancel | |

Repeat 2–5 with each of these and note anything different:
| Case | Works? | Notes |
|---|---|---|
| One file | | |
| Several selected files | | |
| A folder | | |
| Path with spaces, and with non-English characters (e.g. `Рабочий стол\résumé 日本語.png`) | | |
| A file inside OneDrive (both "always keep" and "online-only" placeholder) | | |
| Two monitors, wheel summoned on the second one | | |
| 100 %, 125 %, 150 % and 200 % scaling; and two monitors with different scaling (compare `outer_position`/`outer_size` in the log with the intended `-> overlay (x,y) NxN`) | | |
| After the PC has been asleep and resumed (shortcut still works?) | | |
| Shortcut already owned by another program (try one) → conflict message, not silence | | |

## Known risks this probe is designed to expose (and what I would do about each)
1. **No `DRAG ENTER` until the mouse moves.** Windows decides which window is the drop target when the pointer moves. A wheel
   shown under a perfectly still pointer may not get an enter until the next movement. If so, the wheel shows a "move onto the wheel"
   state, or opens with the pointer slightly off-centre. That is acceptable. If no enter ever arrives, go to risk 2.
2. **wry attaches its drop target to WebView2's child windows when the webview is created.** WebView2 may create that child window
   late for a hidden window, so the overlay never receives drops. Fallback: show the overlay once off-screen at startup, then hide
   it; or (Plan B) a small native Win32 window with our own `IDropTarget` registered through `RegisterDragDrop`, with the webview
   used for drawing only. I would not start the full feature before knowing which.
3. **Escape does not reach the overlay** (it goes to Explorer's drag loop, which cancels the drag). The probe polls the key state
   only while the wheel is visible. This is not a keyboard hook and registers nothing. A keyboard alternative (arrows/Enter) can
   only exist if the wheel is focusable, which would end the drag, so for the Explorer drag path the keyboard alternative is
   **not possible**. The wheel opened from the tray ("Quick Actions") can be fully keyboard-operable.
4. **Real frosted glass.** WebView2 `backdrop-filter` only blurs the page behind it, not the desktop. A transparent window can be
   made translucent and shaded, which is what the probe shows, but true desktop blur needs Windows acrylic applied through the
   window, clipped to a circle with `SetWindowRgn`. I would try it after the drop target works.
5. **Elevation.** If Explorer runs as administrator and OrangeFile does not (or the other way round), Windows blocks drag-and-drop
   between them. Nothing to fix; it will be documented.
6. **Virtual items.** Dragging from a ZIP folder, Libraries, a cloud-only OneDrive placeholder, or a phone may give no
   file paths (`CF_HDROP` absent) or a path that doesn't exist yet. The product must answer "invalid drag payload" for these
   and never touch them.
7. **Multi-monitor / mixed DPI.** Moving a window between monitors with different scaling can make Windows resize it. The probe
   sets position and size before and after showing and logs the final numbers so this can be judged.

## What changes if the answers are good
Then steps 3–9 of the delivery order proceed. The map is in ARCHITECTURE.md ("Planned: Drag Action Wheel"). If risk 2 or 3 turns out
badly, I will report that and propose Plan B before writing the feature.
