// mantis-vpn – pomocník pro VPN tlačítko Mantis Browseru (native messaging host).
// Funguje s libovolným standardním profilem WireGuard (.conf) – PiVPN,
// komerční poskytovatelé, vlastní server. Jiné protokoly (OpenVPN…) ne.
//
// Prohlížeč ho spustí, když rozšíření Mantis otevře spojení, a ukončí ho
// se zavřením prohlížeče. Pomocník:
//   - uloží WireGuard profil z okna VPN do %APPDATA%\mantis\vpn\wg.conf
//   - spustí/zastaví wireproxy (WireGuard → SOCKS5 proxy na 127.0.0.1:25344)
//   - hlásí stav (profil, běží, tunel odpovídá)
// Klíče z profilu nikdy neposílá zpět do prohlížeče.
//
// Protokol: zprávy JSON s 4bajtovou délkou (little-endian) na stdin/stdout.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	socksAddr  = "127.0.0.1:25344"
	healthAddr = "127.0.0.1:25345"
	checkAlive = "1.1.1.1"
	createNoWindow = 0x08000000
)

type request struct {
	Cmd  string `json:"cmd"`
	Conf string `json:"conf,omitempty"`
}

type status struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	HasProfile bool   `json:"hasProfile"`
	Endpoint   string `json:"endpoint,omitempty"`
	Running    bool   `json:"running"`
	Connected  bool   `json:"connected"`
	Proxy      string `json:"proxy"`
}

var (
	mu      sync.Mutex
	proc    *exec.Cmd
	exited  chan struct{}
	dataDir = filepath.Join(os.Getenv("APPDATA"), "mantis", "vpn")
	wgPath  = filepath.Join(dataDir, "wg.conf")
	runPath = filepath.Join(dataDir, "wireproxy.conf")
)

// Řádky wg-quick, kterým wireproxy nerozumí (skripty, směrování systému)
var unsupported = regexp.MustCompile(`(?i)^\s*(PostUp|PostDown|PreUp|PreDown|Table|SaveConfig|FwMark)\s*=`)
var endpointRe = regexp.MustCompile(`(?im)^\s*Endpoint\s*=\s*(\S+)`)

func validate(conf string) error {
	lower := strings.ToLower(conf)
	for _, need := range []string{"[interface]", "privatekey", "[peer]", "publickey", "endpoint"} {
		if !strings.Contains(lower, need) {
			return errors.New("profil není platná konfigurace WireGuard (chybí " + need + "); podporovaný je jen WireGuard")
		}
	}
	return nil
}

func endpoint(conf string) string {
	if m := endpointRe.FindStringSubmatch(conf); m != nil {
		return m[1]
	}
	return ""
}

// Konfigurace pro wireproxy: profil bez nepodporovaných řádků,
// CheckAlive v [Interface] a SOCKS5 proxy.
func runConfig(conf string) string {
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(conf, "\r\n", "\n"), "\n") {
		if unsupported.MatchString(line) || strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "checkalive") {
			continue
		}
		out = append(out, line)
		if strings.EqualFold(strings.TrimSpace(line), "[Interface]") {
			out = append(out, "CheckAlive = "+checkAlive)
		}
	}
	out = append(out, "", "[Socks5]", "BindAddress = "+socksAddr, "")
	return strings.Join(out, "\n")
}

func running() bool {
	if proc == nil {
		return false
	}
	select {
	case <-exited:
		return false
	default:
		return true
	}
}

func connected() bool {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + healthAddr + "/readyz")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func current() status {
	s := status{OK: true, Proxy: socksAddr}
	if data, err := os.ReadFile(wgPath); err == nil {
		s.HasProfile = true
		s.Endpoint = endpoint(string(data))
	}
	s.Running = running()
	if s.Running {
		s.Connected = connected()
	}
	return s
}

func start() error {
	if running() {
		return nil
	}
	data, err := os.ReadFile(wgPath)
	if err != nil {
		return errors.New("není uložený žádný VPN profil")
	}
	if err := os.WriteFile(runPath, []byte(runConfig(string(data))), 0o600); err != nil {
		return err
	}
	exe, _ := os.Executable()
	wireproxy := filepath.Join(filepath.Dir(exe), "wireproxy.exe")
	if _, err := os.Stat(wireproxy); err != nil {
		return errors.New("chybí wireproxy.exe vedle mantis-vpn.exe")
	}
	cmd := exec.Command(wireproxy, "-s", "-c", runPath, "-i", healthAddr)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if err := cmd.Start(); err != nil {
		return err
	}
	proc = cmd
	exited = make(chan struct{})
	go func(c *exec.Cmd, done chan struct{}) { c.Wait(); close(done) }(cmd, exited)

	// počkat, až tunel odpoví (max. 15 s); když ne, wireproxy necháme běžet
	// a prohlížeč uvidí Connected=false
	for i := 0; i < 30 && running(); i++ {
		if connected() {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !running() {
		return errors.New("wireproxy se nepodařilo spustit – zkontrolujte profil")
	}
	return nil
}

func stop() {
	if running() {
		proc.Process.Kill()
		<-exited
	}
	proc = nil
}

func handle(req request) status {
	mu.Lock()
	defer mu.Unlock()
	var err error
	switch req.Cmd {
	case "status":
	case "setProfile":
		if err = validate(req.Conf); err == nil {
			stop()
			if err = os.MkdirAll(dataDir, 0o700); err == nil {
				err = os.WriteFile(wgPath, []byte(req.Conf), 0o600)
			}
		}
	case "removeProfile":
		stop()
		os.Remove(runPath)
		if e := os.Remove(wgPath); e != nil && !os.IsNotExist(e) {
			err = e
		}
	case "start":
		err = start()
	case "stop":
		stop()
	default:
		err = errors.New("neznámý příkaz " + req.Cmd)
	}
	s := current()
	if err != nil {
		s.OK = false
		s.Error = err.Error()
	}
	return s
}

func read(r io.Reader) (request, error) {
	var req request
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return req, err
	}
	if size > 1<<20 {
		return req, errors.New("zpráva je příliš velká")
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		return req, err
	}
	return req, json.Unmarshal(buf, &req)
}

func write(w io.Writer, s status) error {
	buf, _ := json.Marshal(s)
	if err := binary.Write(w, binary.LittleEndian, uint32(len(buf))); err != nil {
		return err
	}
	_, err := w.Write(buf)
	return err
}

func main() {
	in := bufio.NewReader(os.Stdin)
	for {
		req, err := read(in)
		if err != nil {
			break // prohlížeč spojení zavřel
		}
		if write(os.Stdout, handle(req)) != nil {
			break
		}
	}
	mu.Lock()
	stop()
	mu.Unlock()
}
