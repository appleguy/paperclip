// context-budget derives context-aware output and compaction budgets and applies
// them to the owned zero profiles. The CSV is the single source of truth.
package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	root       = "/Volumes/NVM/Paperclip/workspaces/platform-lead-outside/context"
	maxCeiling = 32768 // used only when upstream publishes no model output maximum
	minMargin  = 16000 // OpenCode's minimum compaction room; stronger than the initial proposal's 4096
)

type Profile struct {
	Agent, Harness, Name, Model                    string
	Context, ModelMax, Output, Margin, AutoCompact int
	Assumed                                        bool
}

func derive(c, max int) (o, margin, a int, assumed bool, err error) {
	if c <= 0 {
		return 0, 0, 0, false, fmt.Errorf("context must be positive")
	}
	if max <= 0 {
		max, assumed = maxCeiling, true
	}
	o = int(math.Round(float64(c) / 16))
	if o < 4096 {
		o = 4096
	}
	if o > max {
		o = max
	}
	margin = c / 50
	if margin < minMargin {
		margin = minMargin
	}
	a = c - o - margin
	if a < 0 {
		a = 0
	}
	return
}

func loadTable(path string) ([]Profile, error) {
	if path == "" {
		path = filepath.Join("/Volumes/NVM/Paperclip/master/tools/context-budget", "profiles.csv")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(f)
	r.FieldsPerRecord = 6
	records, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	var ps []Profile
	for i, row := range records {
		if i == 0 {
			continue
		}
		c, e := strconv.Atoi(row[4])
		if e != nil {
			return nil, e
		}
		m, e := strconv.Atoi(row[5])
		if e != nil {
			return nil, e
		}
		o, margin, a, assumed, e := derive(c, m)
		if e != nil {
			return nil, e
		}
		ps = append(ps, Profile{row[0], row[1], row[2], row[3], c, m, o, margin, a, assumed})
	}
	return ps, nil
}

func tomlSet(data, key string, val int) string {
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `\s*=\s*[^\r\n]*`)
	line := fmt.Sprintf("%s = %d", key, val)
	if re.MatchString(data) {
		return re.ReplaceAllString(data, line)
	}
	// Root-level config settings must precede the first TOML table.
	idx := strings.Index(data, "\n[")
	if idx < 0 {
		return strings.TrimRight(data, "\n") + "\n" + line + "\n"
	}
	return strings.TrimRight(data[:idx], "\n") + "\n" + line + data[idx:]
}

func updateCodex(check bool, p Profile) error {
	path := filepath.Join(root, "codex-home/config.toml")
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	s := string(b)
	compact := p.AutoCompact
	// Codex's runtime clamps this setting to 90% of the context window.
	if cap := p.Context * 90 / 100; compact > cap {
		compact = cap
	}
	for k, v := range map[string]int{"model_context_window": p.Context, "model_auto_compact_token_limit": compact} {
		s = tomlSet(s, k, v)
	}
	if string(b) == s {
		return nil
	}
	if check {
		return fmt.Errorf("drift: %s", path)
	}
	return os.WriteFile(path, []byte(s), 0600)
}

func setModelLimits(doc map[string]any, p Profile) error {
	providers, ok := doc["provider"].(map[string]any)
	if !ok {
		return errors.New("provider object missing")
	}
	for _, raw := range providers {
		provider, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		models, ok := provider["models"].(map[string]any)
		if !ok {
			continue
		}
		model, ok := models[p.Model].(map[string]any)
		if !ok {
			continue
		}
		limit, ok := model["limit"].(map[string]any)
		if !ok {
			limit = map[string]any{}
			model["limit"] = limit
		}
		limit["context"], limit["output"] = p.Context, p.Output
		return nil
	}
	return fmt.Errorf("model %q not found in profile %s", p.Model, p.Name)
}

func overlayValues(ps []Profile, profile string) (map[string]any, error) {
	models := map[string]any{}
	buffer := 0
	for _, p := range ps {
		if p.Harness != "opencode" || p.Name != profile {
			continue
		}
		models[p.Model] = map[string]int{"context": p.Context, "output": p.Output}
		if reserve := p.Output + p.Margin; reserve > buffer {
			buffer = reserve
		}
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("no OpenCode rows for profile %s", profile)
	}
	return map[string]any{"models": models, "buffer": buffer}, nil
}

func updateOpenCode(path string, ps []Profile, check bool, profile string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc map[string]any
	if err = json.Unmarshal(b, &doc); err != nil {
		return err
	}
	if profile == "" {
		profile = filepath.Base(filepath.Dir(filepath.Dir(path)))
	}
	var chosen []Profile
	for _, p := range ps {
		if p.Harness == "opencode" && p.Name == profile {
			chosen = append(chosen, p)
		}
	}
	if len(chosen) == 0 {
		return fmt.Errorf("no CSV rows for profile %s", profile)
	}
	for _, p := range chosen {
		if err = setModelLimits(doc, p); err != nil {
			return err
		}
	}
	comp, _ := doc["compaction"].(map[string]any)
	if comp == nil {
		comp = map[string]any{}
		doc["compaction"] = comp
	}
	comp["auto"] = true
	// OpenCode's buffer is free headroom below the model's context ceiling.
	// A shared profile buffer must cover its largest derived reply plus margin.
	buffer := 0
	for _, p := range chosen {
		if reserve := p.Output + p.Margin; reserve > buffer {
			buffer = reserve
		}
	}
	comp["buffer"] = buffer
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	if string(out) == string(b) {
		return nil
	}
	if check {
		return fmt.Errorf("drift: %s", path)
	}
	return os.WriteFile(path, out, 0600)
}

func profiles() ([]string, error) {
	return filepath.Glob(filepath.Join(root, "opencode", "*", "config", "opencode.json"))
}

func main() {
	check := flag.Bool("check", false, "report drift without writing")
	overlay := flag.String("overlay", "", "apply only one OpenCode profile to a generated config file")
	overlayJSON := flag.String("overlay-json", "", "print derived JSON limits for one OpenCode profile")
	table := flag.String("table", "", "override profile CSV path")
	flag.Parse()
	ps, err := loadTable(*table)
	if err != nil {
		fatal(err)
	}
	if *overlay != "" {
		name := *overlay
		target := ""
		if flag.NArg() > 0 {
			target = flag.Arg(0)
		}
		if target == "" {
			fatal(errors.New("--overlay requires PROFILE and CONFIG path"))
		}
		selected := false
		for _, p := range ps {
			if p.Name == name && p.Harness == "opencode" {
				selected = true
			}
		}
		if !selected {
			fatal(fmt.Errorf("unknown OpenCode profile %q", name))
		}
		if err = updateOpenCode(target, ps, false, name); err != nil {
			fatal(err)
		}
		return
	}
	if *overlayJSON != "" {
		values, err := overlayValues(ps, *overlayJSON)
		if err != nil {
			fatal(err)
		}
		data, err := json.Marshal(values)
		if err != nil {
			fatal(err)
		}
		fmt.Println(string(data))
		return
	}
	for _, p := range ps {
		fmt.Printf("%s\t%s\tC=%d\tO=%d\tA=%d\tmargin=%d\tmax=%s\n", p.Agent, p.Harness, p.Context, p.Output, p.AutoCompact, p.Margin, assumed(p.Assumed))
	}
	for _, p := range ps {
		if p.Harness == "codex" {
			if err = updateCodex(*check, p); err != nil {
				fatal(err)
			}
		}
	}
	paths, err := profiles()
	if err != nil {
		fatal(err)
	}
	for _, path := range paths {
		if err = updateOpenCode(path, ps, *check, ""); err != nil {
			fatal(err)
		}
	}
}
func assumed(v bool) string {
	if v {
		return "assumed"
	}
	return "verified"
}
func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
