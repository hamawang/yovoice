package workbench

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// validateTimeline 限制剪辑数量和源范围，允许编辑空音轨。
func validateTimeline(timeline *AudioTimeline, history []Generation) error {
	if timeline == nil {
		return nil
	}
	bad := Err(MsgErrTimelineInvalid, nil)
	if len(timeline.AcceptedGenerations) > 100000 {
		return bad
	}
	for _, id := range timeline.AcceptedGenerations {
		if !validID(id) {
			return bad
		}
	}
	if timeline.RegenerateMode != "" && timeline.RegenerateMode != "ripple" && timeline.RegenerateMode != "preserve" {
		return bad
	}
	markerIDs := map[string]bool{}
	if len(timeline.Markers) > 2000 {
		return bad
	}
	for _, marker := range timeline.Markers {
		if marker.ID == "" || len(marker.ID) > 64 || markerIDs[marker.ID] || !inRange(marker.Time, 0, 86400) || strings.TrimSpace(marker.Name) == "" || textLen(marker.Name) > 120 {
			return bad
		}
		markerIDs[marker.ID] = true
	}
	if len(timeline.Tracks) > 32 {
		return bad
	}
	sources := map[string]float64{}
	for _, generation := range history {
		sources[generation.ID] = generation.Duration
	}
	assets := map[string]float64{}
	for _, asset := range timeline.Assets {
		if !validID(asset.ID) || asset.FileName != "import-"+asset.ID+".wav" || strings.TrimSpace(asset.Name) == "" || textLen(asset.Name) > 120 || !inRange(asset.Duration, 0.01, 3600) || assets[asset.ID] != 0 {
			return bad
		}
		assets[asset.ID] = asset.Duration
	}
	if len(assets) > 2000 {
		return bad
	}
	ids := map[string]bool{}
	count := 0
	for _, track := range timeline.Tracks {
		if !inRange(track.GainDB, -60, 12) || !inRange(track.DuckDB, 0, 36) {
			return bad
		}
		if track.ID == "" || len(track.ID) > 64 || ids[track.ID] || strings.TrimSpace(track.Name) == "" || textLen(track.Name) > 120 {
			return bad
		}
		ids[track.ID] = true
		for _, clip := range track.Clips {
			if !inRange(clip.GainDB, -60, 12) || !inRange(clip.FadeIn, 0, 3600) || !inRange(clip.FadeOut, 0, 3600) {
				return bad
			}
			count++
			duration, exists := sources[clip.GenerationID]
			if clip.AssetID != "" {
				if clip.GenerationID != "" {
					return bad
				}
				duration, exists = assets[clip.AssetID]
			}
			if count > 2000 || clip.ID == "" || len(clip.ID) > 64 || ids[clip.ID] || !exists || !inRange(clip.Start, 0, 86400) || !inRange(clip.Offset, 0, duration) || !inRange(clip.Duration, 0.01, duration) || clip.Offset+clip.Duration > duration+0.001 || clip.Start+clip.Duration > 86400 {
				return bad
			}
			ids[clip.ID] = true
		}
	}
	return nil
}

// 上传素材属于作品时间线，不写入生成记录或参考音频库。
func (w *Workbench) importTimelineAudio(ctx context.Context, path, name string) (AudioAsset, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	duration, err := Duration(path)
	if err != nil {
		converter, e := w.audioConverter()
		if e != nil {
			return AudioAsset{}, e
		}
		converted := filepath.Join(w.Store.Root, "downloads", newID()+".wav")
		defer os.Remove(converted)
		if e = convertAudioWithLimit(ctx, converter, path, converted, 3600); e != nil {
			return AudioAsset{}, e
		}
		path = converted
		duration, err = Duration(path)
	}
	if err != nil {
		return AudioAsset{}, err
	}
	if !inRange(duration, 0.01, 3600) {
		return AudioAsset{}, Err(MsgErrTimelineImportDuration, nil)
	}
	name = strings.TrimSpace(name)
	if name == "" || textLen(name) > 120 {
		return AudioAsset{}, Err(MsgErrNameLength, nil)
	}
	id := newID()
	asset := AudioAsset{ID: id, Name: name, FileName: "import-" + id + ".wav", Duration: duration}
	dest, err := w.Store.MediaPath("outputs", asset.FileName)
	if err != nil {
		return AudioAsset{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return AudioAsset{}, err
	}
	if err = os.WriteFile(dest, data, 0600); err != nil {
		return AudioAsset{}, err
	}
	return asset, nil
}

// 保存时核对真实源文件，不能用客户端提交的时长绕过裁剪范围校验。
func (w *Workbench) validateTimelineAssets(timeline *AudioTimeline) error {
	if timeline == nil {
		return nil
	}
	if len(timeline.Assets) > 2000 {
		return Err(MsgErrTimelineInvalid, nil)
	}
	for _, asset := range timeline.Assets {
		if !validID(asset.ID) || asset.FileName != "import-"+asset.ID+".wav" {
			return Err(MsgErrTimelineInvalid, nil)
		}
		path, err := w.Store.MediaPath("outputs", asset.FileName)
		if err != nil {
			return err
		}
		duration, err := Duration(path)
		if err != nil {
			return err
		}
		if math.Abs(duration-asset.Duration) > 0.001 {
			return Err(MsgErrTimelineInvalid, nil)
		}
	}
	return nil
}
