package main

import "testing"

func TestDerivedBudgets(t *testing.T) {
	cases := []struct{ context, max, output, margin, compact int }{
		{200000, 0, 12500, 16000, 171500},
		{131072, 0, 8192, 16000, 106880},
		{85504, 0, 5344, 16000, 64160},
		{81920, 0, 5120, 16000, 60800},
	}
	for _, tc := range cases {
		o, m, a, assumed, err := derive(tc.context, tc.max)
		if err != nil || o != tc.output || m != tc.margin || a != tc.compact || !assumed {
			t.Fatalf("derive(%d,%d) = (%d,%d,%d,%v,%v); want (%d,%d,%d,assumed)", tc.context, tc.max, o, m, a, assumed, err, tc.output, tc.margin, tc.compact)
		}
	}
}

func TestPublishedModelOutputCapAndOpenCodeOverlay(t *testing.T) {
	o, margin, a, assumed, err := derive(200000, 128000)
	if err != nil || o != 12500 || margin != 16000 || a != 171500 || assumed {
		t.Fatalf("derive with published cap = (%d,%d,%d,%v,%v); want (12500,16000,171500,false,nil)", o, margin, a, assumed, err)
	}
	ps := []Profile{
		{Harness: "opencode", Name: "qwen", Model: "qwen3.8-27b-3090", Context: 85504, Output: 5344, Margin: 16000},
		{Harness: "opencode", Name: "qwen", Model: "qwen3.8-27b-4090", Context: 81920, Output: 5120, Margin: 16000},
		{Harness: "opencode", Name: "qwen", Model: "qwen", Context: 81920, Output: 5120, Margin: 16000},
	}
	values, err := overlayValues(ps, "qwen")
	if err != nil {
		t.Fatal(err)
	}
	if len(values["models"].(map[string]any)) != 3 || values["buffer"] != 21344 {
		t.Fatalf("unexpected shared Qwen overlay: %#v", values)
	}
}

func TestTomlSetPreservesOtherSettings(t *testing.T) {
	in := "model = \"sample\"\nkeep = true\n\n[features]\napps = false\n"
	got := tomlSet(in, "model_auto_compact_token_limit", 12345)
	if got != "model = \"sample\"\nkeep = true\nmodel_auto_compact_token_limit = 12345\n[features]\napps = false\n" {
		t.Fatalf("unexpected TOML update:\n%s", got)
	}
}
