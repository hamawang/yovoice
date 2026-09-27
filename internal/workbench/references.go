package workbench

// voiceUsers 检查素材的完整引用范围，避免删除后角色或历史版本无法重现。
func (s State) voiceUsers(id string) []string {
	uses := func(settings SynthesisSettings) bool {
		return value(settings.VoiceID) == id || value(settings.EmotionVoiceID) == id
	}
	draftUses := func(d Draft) bool {
		if uses(d.SynthesisSettings) {
			return true
		}
		if d.Subtitles != nil {
			for _, speaker := range d.Subtitles.Speakers {
				if speaker.Settings != nil && uses(*speaker.Settings) {
					return true
				}
			}
		}
		return false
	}
	var names []string
	for _, c := range s.Characters {
		if uses(c.Settings) {
			names = append(names, c.Name)
		}
	}
	for _, d := range s.Drafts {
		if draftUses(d) {
			names = append(names, d.Title)
		}
	}
	for _, g := range s.History {
		if draftUses(g.Settings) {
			names = append(names, g.Title)
		}
	}
	return names
}
