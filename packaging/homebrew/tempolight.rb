#~ Template (lines starting with #~ are dropped): scripts/release-manifests.js fills in the {{…}} placeholders from a
#~ release, and the release workflow copies the result to Formula/tempolight.rb in the tap repository
#~ D4RKGEEK/homebrew-tempolight (see docs/install.md).
# Homebrew formula for Tempolight's one-file app.
#   brew install d4rkgeek/tempolight/tempolight
class Tempolight < Formula
  desc "Music-reactive lighting for WLED that understands the song"
  homepage "https://github.com/D4RKGEEK/tempolight"
  version "{{version}}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/D4RKGEEK/tempolight/releases/download/v{{version}}/tempolight-macos-arm64.zip"
      sha256 "{{sha256:tempolight-macos-arm64.zip}}"
    end
    on_intel do
      url "https://github.com/D4RKGEEK/tempolight/releases/download/v{{version}}/tempolight-macos-x64.zip"
      sha256 "{{sha256:tempolight-macos-x64.zip}}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/D4RKGEEK/tempolight/releases/download/v{{version}}/tempolight-linux-arm64.tar.gz"
      sha256 "{{sha256:tempolight-linux-arm64.tar.gz}}"
    end
    on_intel do
      url "https://github.com/D4RKGEEK/tempolight/releases/download/v{{version}}/tempolight-linux-x64.tar.gz"
      sha256 "{{sha256:tempolight-linux-x64.tar.gz}}"
    end
  end

  def install
    bin.install "tempolight"
  end

  # brew services start tempolight: runs at login and restarts if it stops
  service do
    run [opt_bin/"tempolight", "--port", "8080"]
    keep_alive true
    log_path var/"log/tempolight.log"
    error_log_path var/"log/tempolight.log"
  end

  def caveats
    <<~EOS
      Start it and open the web app:
        tempolight --open
      Or keep it running in the background:
        brew services start tempolight
      and open http://localhost:8080. Settings are saved in ~/.tempolight.
    EOS
  end

  test do
    port = free_port
    pid = spawn bin/"tempolight", "--port", port.to_s, "--host", "127.0.0.1", "--data", testpath/"data", "--no-discover"
    sleep 3
    assert_match '"ok":true', shell_output("curl -fs http://127.0.0.1:#{port}/api/health")
  ensure
    Process.kill("TERM", pid) if pid
  end
end
