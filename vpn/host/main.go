// mantis-vpn – pomocník pro VPN tlačítko Mantis Browseru (native messaging host).
// Funguje s libovolným standardním profilem WireGuard (.conf) – PiVPN,
// komerční poskytovatelé, vlastní server. Jiné protokoly (OpenVPN…) ne.
//
// Prohlížeč ho spustí, když rozšíření Mantis otevře spojení, a ukončí ho
// se zavřením prohlížeče. Pomocník:
//   - uloží WireGuard profil z okna VPN do %LOCALAPPDATA%\mantis\vpn\wg.conf.dpapi
//   - spustí/zastaví wireproxy (WireGuard → SOCKS5 proxy na 127.0.0.1:25344)
//   - hlásí stav (profil, běží, tunel odpovídá)
//
// Bezpečnost:
//   - Klíče z profilu nikdy neposílá zpět do prohlížeče.
//   - Profil je zašifrovaný přes Windows DPAPI (rozšifruje ho jen stejný uživatel na
//     stejném počítači) a leží v Local, ne v Roaming – ten se na firemních počítačích
//     kopíruje na server a berou ho zálohy. wireproxy potřebuje konfiguraci jako soubor:
//     ten vzniká jen na dobu spuštění a hned potom se smaže.
//   - SOCKS5 proxy chrání náhodné jméno a heslo vygenerované při každém spuštění
//     (dostane je jen rozšíření Mantis) – tunel nemůže použít jiný program.
//   - Informační HTTP rozhraní wireproxy (-i) se nespouští (prozrazovalo by
//     adresu serveru a statistiky; bez kontroly Host by šlo číst přes DNS rebinding).
//     Stav tunelu se zjišťuje spojením přes proxy skrz tunel.
//
// Protokol: zprávy JSON s 4bajtovou délkou (little-endian) na stdin/stdout.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	socksAddr      = "127.0.0.1:25344"
	fallbackProbe  = "1.1.1.1:443" // když profil nemá DNS server
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
	SocksUser  string `json:"socksUser,omitempty"`
	SocksPass  string `json:"socksPass,omitempty"`
}

var (
	mu        sync.Mutex
	proc      *exec.Cmd
	exited    chan struct{}
	socksUser string
	socksPass string
	probeAddr = fallbackProbe
	dataDir   = filepath.Join(os.Getenv("LOCALAPPDATA"), "mantis", "vpn")
	wgPath    = filepath.Join(dataDir, "wg.conf.dpapi")
	runPath   = filepath.Join(dataDir, "wireproxy.conf")
	// sestavení 1–2 ukládala profil nešifrovaně do Roaming
	legacyDir = filepath.Join(os.Getenv("APPDATA"), "mantis", "vpn")
)

// ---------- Šifrování profilu (Windows DPAPI) ----------

var (
	crypt32           = syscall.NewLazyDLL("crypt32.dll")
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	procProtectData   = crypt32.NewProc("CryptProtectData")
	procUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree     = kernel32.NewProc("LocalFree")
	dpapiEntropy      = []byte("cz.mantis.vpn")
)

const cryptprotectUIForbidden = 0x1

type dataBlob struct {
	size uint32
	data *byte
}

func newBlob(b []byte) *dataBlob {
	if len(b) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{size: uint32(len(b)), data: &b[0]}
}

// CryptProtectData i CryptUnprotectData mají stejné parametry:
// (vstup, popis, entropie, rezervováno, výzva, příznaky, výstup)
func dpapi(proc *syscall.LazyProc, in []byte) ([]byte, error) {
	if len(in) == 0 {
		return nil, errors.New("prázdná data")
	}
	var out dataBlob
	r, _, err := proc.Call(
		uintptr(unsafe.Pointer(newBlob(in))), 0,
		uintptr(unsafe.Pointer(newBlob(dpapiEntropy))), 0, 0,
		cryptprotectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	return append([]byte(nil), unsafe.Slice(out.data, out.size)...), nil
}

func loadProfile() (string, error) {
	enc, err := os.ReadFile(wgPath)
	if err != nil {
		return "", errors.New("není uložený žádný VPN profil")
	}
	plain, err := dpapi(procUnprotectData, enc)
	if err != nil {
		return "", errors.New("VPN profil nejde rozšifrovat (jiný uživatel nebo počítač?) – vložte ho znovu")
	}
	return string(plain), nil
}

func saveProfile(conf string) error {
	enc, err := dpapi(procProtectData, []byte(conf))
	if err != nil {
		return errors.New("VPN profil se nepodařilo zašifrovat: " + err.Error())
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	tmp := wgPath + ".part"
	if err := os.WriteFile(tmp, enc, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, wgPath)
}

// Nešifrovaný profil ze starší verze → zašifrovat do nového místa, starý smazat.
// Když zašifrování selže, starý soubor zůstane a zkusí se to příště.
func migrate() {
	old := filepath.Join(legacyDir, "wg.conf")
	if data, err := os.ReadFile(old); err == nil {
		if _, e := os.Stat(wgPath); os.IsNotExist(e) {
			if saveProfile(string(data)) != nil {
				return
			}
		}
		os.Remove(old)
	}
	os.Remove(filepath.Join(legacyDir, "wireproxy.conf"))
	os.Remove(legacyDir) // jen složka vpn, a jen když je prázdná (profil prohlížeče je o úroveň výš)
}

// Řádky wg-quick, kterým wireproxy nerozumí (skripty, směrování systému),
// a CheckAlive (stav tunelu zjišťujeme sami)
var unsupported = regexp.MustCompile(`(?i)^\s*(PostUp|PostDown|PreUp|PreDown|Table|SaveConfig|FwMark|CheckAlive|CheckAliveInterval)\s*=`)
var endpointRe = regexp.MustCompile(`(?im)^\s*Endpoint\s*=\s*(\S+)`)
var dnsRe = regexp.MustCompile(`(?im)^\s*DNS\s*=\s*(.+)$`)

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

// Cíl kontroly tunelu: první IPv4 DNS server z profilu (TCP 53 – odpovídá i přes
// tunel jen do domácí sítě), jinak 1.1.1.1:443
func probeTarget(conf string) string {
	if m := dnsRe.FindStringSubmatch(conf); m != nil {
		for _, part := range strings.Split(m[1], ",") {
			if ip := net.ParseIP(strings.TrimSpace(part)); ip != nil && ip.To4() != nil {
				return net.JoinHostPort(ip.String(), "53")
			}
		}
	}
	return fallbackProbe
}

func randomToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Konfigurace pro wireproxy: profil bez nepodporovaných řádků
// a SOCKS5 proxy s jednorázovým jménem a heslem.
func runConfig(conf, user, pass string) string {
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(conf, "\r\n", "\n"), "\n") {
		if !unsupported.MatchString(line) {
			out = append(out, line)
		}
	}
	out = append(out, "", "[Socks5]", "BindAddress = "+socksAddr,
		"Username = "+user, "Password = "+pass, "")
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

// Tunel odpovídá = přes proxy (se jménem a heslem) jde navázat TCP spojení skrz
// WireGuard na DNS server z profilu, případně na 1.1.1.1:443 (některé DNS servery
// TCP nepřijímají). wireproxy potvrdí CONNECT až po spojení s cílem.
func connected() bool {
	if socksUser == "" {
		return false
	}
	if probe(probeAddr) {
		return true
	}
	return probeAddr != fallbackProbe && probe(fallbackProbe)
}

func probe(target string) bool {
	host, portStr, err := net.SplitHostPort(target)
	ip := net.ParseIP(host).To4()
	port, perr := strconv.Atoi(portStr)
	if err != nil || ip == nil || perr != nil {
		return false
	}
	conn, err := net.DialTimeout("tcp", socksAddr, 2*time.Second)
	if err != nil {
		return false
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(4 * time.Second))

	reply := make([]byte, 2)
	// pozdrav: SOCKS5, 1 metoda, 0x02 = jméno/heslo (RFC 1928, 1929)
	if _, err := conn.Write([]byte{5, 1, 2}); err != nil {
		return false
	}
	if _, err := io.ReadFull(conn, reply); err != nil || reply[0] != 5 || reply[1] != 2 {
		return false
	}
	auth := []byte{1, byte(len(socksUser))}
	auth = append(auth, socksUser...)
	auth = append(auth, byte(len(socksPass)))
	auth = append(auth, socksPass...)
	if _, err := conn.Write(auth); err != nil {
		return false
	}
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		return false
	}
	req := []byte{5, 1, 0, 1, ip[0], ip[1], ip[2], ip[3], byte(port >> 8), byte(port)}
	if _, err := conn.Write(req); err != nil {
		return false
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return false
	}
	return head[0] == 5 && head[1] == 0
}

func current() status {
	s := status{OK: true, Proxy: socksAddr}
	if _, err := os.Stat(wgPath); err == nil {
		s.HasProfile = true
		if conf, err := loadProfile(); err == nil {
			s.Endpoint = endpoint(conf)
		}
	}
	s.Running = running()
	if s.Running {
		s.Connected = connected()
		s.SocksUser = socksUser
		s.SocksPass = socksPass
	}
	return s
}

func start() error {
	if running() {
		return nil
	}
	conf, err := loadProfile()
	if err != nil {
		return err
	}
	exe, _ := os.Executable()
	wireproxy := filepath.Join(filepath.Dir(exe), "wireproxy.exe")
	if _, err := os.Stat(wireproxy); err != nil {
		return errors.New("chybí wireproxy.exe vedle mantis-vpn.exe")
	}
	user, err := randomToken()
	if err != nil {
		return err
	}
	pass, err := randomToken()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(runPath, []byte(runConfig(conf, user, pass)), 0o600); err != nil {
		return err
	}
	// wireproxy konfiguraci načte hned po spuštění; smazat ji, jakmile start skončí
	// (tunel odpovídá, vypršel čas, nebo wireproxy skončila)
	defer os.Remove(runPath)
	cmd := exec.Command(wireproxy, "-s", "-c", runPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	if err := cmd.Start(); err != nil {
		return err
	}
	proc = cmd
	exited = make(chan struct{})
	socksUser, socksPass = user, pass
	probeAddr = probeTarget(conf)
	go func(c *exec.Cmd, done chan struct{}) { c.Wait(); close(done) }(cmd, exited)

	// počkat, až tunel odpoví (max. ~15 s); když ne, wireproxy necháme běžet
	// a prohlížeč uvidí Connected=false
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && running() {
		if connected() {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !running() {
		socksUser, socksPass = "", ""
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
	socksUser, socksPass = "", ""
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
			err = saveProfile(req.Conf)
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
	migrate()
	os.Remove(runPath) // zbytek po pádu
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
