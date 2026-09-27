package workbench

import "testing"

func TestStoreDoesNotReplayPreviousFailure(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root)
	must(t, err)
	for _, status := range []string{"failed", "running"} {
		must(t, store.Update(func(state *State) {
			code := MsgErrAudioDecode
			state.Activity = &Activity{Kind: "generate", Status: status, Code: MsgActivityFailed, ErrorCode: &code}
		}, true))
		reopened, err := NewStore(root)
		must(t, err)
		activity := reopened.Read().Activity
		if status == "failed" && activity != nil {
			t.Fatal("重启不应重新显示历史失败提示")
		}
		if status == "running" && (activity == nil || activity.Status != "interrupted" || activity.ErrorCode != nil) {
			t.Fatal("未结束的操作仍应标记为中断")
		}
	}
}
