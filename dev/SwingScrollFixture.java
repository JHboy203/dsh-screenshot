// dev/SwingScrollFixture.java -- a REAL Java Swing scroll container, for measuring posted wheel
// messages (R32, backlog item "Qt / Java / self-drawn scroll containers: which ones accept it").
//
// WHY SWING SPECIFICALLY
//   Swing draws and routes its own input: the wheel event that reaches a JScrollPane comes from
//   AWT's Windows peer. Whether that peer reads the coordinates from the MESSAGE (lParam) or from
//   the REAL cursor (MouseInfo.getPointerInfo()) decides whether a posted WM_MOUSEWHEEL scrolls at
//   all. That is not documented in a way worth trusting -- it is measured.
//
// GROUND TRUTH IS THE SCROLLBAR ITSELF
//   Every adjustment is appended to the log as "value=<int>". "Did it scroll" is a number.
//
// RUN (source-file mode, JDK 11+, no build step):
//   java dev/SwingScrollFixture.java 100 100 460 340 <log> <info> 60
//
// ASCII ONLY.
import java.awt.Font;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

import javax.swing.DefaultListModel;
import javax.swing.JFrame;
import javax.swing.JList;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.SwingUtilities;

public class SwingScrollFixture {

  static String LOG = "swing-scroll.log";
  static String INFO = "";

  static void log(String line) {
    try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(
        Paths.get(LOG), StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.CREATE,
        java.nio.file.StandardOpenOption.APPEND))) {
      out.println(line);
    } catch (Exception ignored) {
    }
  }

  public static void main(String[] args) throws Exception {
    int x = args.length > 0 ? Integer.parseInt(args[0]) : 100;
    int y = args.length > 1 ? Integer.parseInt(args[1]) : 100;
    int w = args.length > 2 ? Integer.parseInt(args[2]) : 460;
    int h = args.length > 3 ? Integer.parseInt(args[3]) : 340;
    if (args.length > 4) LOG = args[4];
    if (args.length > 5) INFO = args[5];
    int seconds = args.length > 6 ? Integer.parseInt(args[6]) : 60;

    log("start");

    final int[] box = { x, y, w, h };
    SwingUtilities.invokeLater(() -> {
      try {
        JFrame f = new JFrame("DSH-JAVA-SCROLL");
        DefaultListModel<String> model = new DefaultListModel<>();
        for (int i = 1; i <= 400; i++) {
          model.addElement(String.format("ITEM %03d ----------------------------", i));
        }
        JList<String> list = new JList<>(model);
        list.setFont(new Font("Consolas", Font.BOLD, 16));
        JScrollPane sp = new JScrollPane(list);
        f.setContentPane(sp);
        f.setBounds(box[0], box[1], box[2], box[3]);
        f.setAlwaysOnTop(true);   // see the Qt fixture: a covered fixture proves nothing
        JScrollBar sb = sp.getVerticalScrollBar();
        sb.addAdjustmentListener(e -> log("value=" + e.getValue()));
        f.setVisible(true);

        // Info is written on the first paint, when geometry is real.
        // NOTE: the scroll POINT is NOT reported from here. Reading a Swing component's screen
        // position off the EDT produced a nonsense value (y=4301 for a window at y=70), so the
        // probe derives the point from this frame rectangle instead -- an ordinary titled window
        // that ps/windows.ps1 can enumerate.
        new Thread(() -> {
          try {
            Thread.sleep(500);
            String json = String.format(
                "{\"ok\":true,\"toolkit\":\"java\",\"java\":\"%s\",\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"value\":%d}",
                System.getProperty("java.version"), f.getX(), f.getY(), f.getWidth(), f.getHeight(),
                sb.getValue());
            if (!INFO.isEmpty()) {
              Files.write(Paths.get(INFO), json.getBytes(StandardCharsets.UTF_8));
            }
            log("shown " + json);
            Thread.sleep(Math.max(1, seconds) * 1000L);
            System.exit(0);
          } catch (Exception exc) {
            log("info-error " + exc);
          }
        }).start();
      } catch (Exception exc) {
        log("ui-error " + exc);
      }
    });
  }
}
