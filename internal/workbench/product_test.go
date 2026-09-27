package workbench

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestProjectMetadataAndReferenceSafety(t *testing.T) {
	w, err := New(t.TempDir())
	must(t, err)
	defer w.Close()
	d := DefaultDraft()
	d.Kind = "story"
	must(t, w.SaveDraft(d))
	saved := w.Store.Read().Drafts[0]
	if saved.Kind != "story" || saved.CreatedAt == nil || saved.UpdatedAt == nil {
		t.Fatal("作品信息没有保存")
	}
	must(t, w.SaveDraft(d))
	if !w.Store.Read().Drafts[0].UpdatedAt.Equal(*saved.UpdatedAt) || !w.Store.Read().Drafts[0].CreatedAt.Equal(*saved.CreatedAt) {
		t.Fatal("打开作品改变了修改时间")
	}
	store, err := NewStore(w.Store.Root)
	must(t, err)
	if store.Read().Drafts[0].Kind != "story" {
		t.Fatal("重启丢失作品类型")
	}
	d.Kind = "unknown"
	if w.SaveDraft(d) == nil {
		t.Fatal("接受了未知作品类型")
	}
	d.Kind = "story"
	id := newID()
	path, err := w.Store.MediaPath("voices", id+".wav")
	must(t, err)
	must(t, os.WriteFile(path, wav(), 0600))
	settings := d.SynthesisSettings
	settings.VoiceID = &id
	d.Text = ""
	d.Subtitles = &SubtitleDocument{Speakers: []SubtitleSpeaker{{ID: "narrator", Settings: &settings}}, Cues: []SubtitleCue{}}
	must(t, w.Store.Update(func(s *State) {
		s.Voices = append(s.Voices, Voice{ID: id, Name: "参考录音", FileName: id + ".wav", Duration: 1})
	}, true))
	must(t, w.SaveDraft(d))
	if w.deleteMedia("voices", id) == nil {
		t.Fatal("删除了作品角色引用的录音")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("引用检查破坏了录音", err)
	}
	d.Subtitles = nil
	must(t, w.SaveDraft(d))
	must(t, w.Store.Update(func(s *State) {
		snapshot := d
		snapshot.SynthesisSettings = settings
		s.History = append(s.History, Generation{ID: newID(), Title: "旧版本", Settings: snapshot})
	}, true))
	if w.deleteMedia("voices", id) == nil {
		t.Fatal("删除了历史快照引用的录音")
	}
}

func TestGenerationActivityKeepsOwner(t *testing.T) {
	w, err := New(t.TempDir())
	must(t, err)
	defer w.Close()
	id := newID()
	must(t, w.begin("generate", MsgActivityGenerate, nil, nil, func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }, "", id))
	activity := w.Store.Read().Activity
	if activity.ProjectID != id || activity.CharacterID != "" {
		t.Fatal("任务归属错误", activity)
	}
	encoded, err := json.Marshal(activity)
	must(t, err)
	var restored Activity
	must(t, json.Unmarshal(encoded, &restored))
	if restored.ProjectID != id {
		t.Fatal("任务归属无法序列化")
	}
}
