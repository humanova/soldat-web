package main

// Soldat Reloaded's wire, as its own code lays it out: the field tables its snapshots and
// words are written by (core/network/fields.odin reads them off the structs' tags), the
// variants of its unions in their numbering, and its enums. Printed as JSON for the relay
// (relay/lib/reloaded/), which speaks the wire from it. Built against a checkout of
// soldatreloaded: tools/reloaded/dump-wire.sh.

import "base:runtime"
import "core:fmt"
import "core:reflect"
import "core:strings"

import "sr:core/game"
import net "sr:core/network"
import res "sr:core/resources"

b: strings.Builder

field_kind :: proc(k: net.Field_Kind) -> string {
	switch k {
	case .Unsigned:  return "unsigned"
	case .Signed:    return "signed"
	case .Bool:      return "bool"
	case .F32:       return "f32"
	case .Vec2:      return "vec2"
	case .Rgba:      return "rgba"
	case .Maybe:     return "maybe"
	case .Animation: return "animation"
	}
	return "?"
}

table :: proc(fields: net.Field_Table) {
	strings.write_string(&b, "[")
	for f, i in fields {
		if i > 0 do strings.write_string(&b, ",")
		fmt.sbprintf(&b, "\n    {{\"name\":%q,\"kind\":%q,\"bits\":%d,\"max\":%d}}", f.name, field_kind(f.kind), f.bits, f.max)
	}
	strings.write_string(&b, "]")
}

// a union's variants, each with its fields or, a union itself, its own variants
variants :: proc(info: ^runtime.Type_Info) {
	u := runtime.type_info_base(info).variant.(runtime.Type_Info_Union)
	strings.write_string(&b, "[")
	for v, i in u.variants {
		if i > 0 do strings.write_string(&b, ",")
		fmt.sbprintf(&b, "\n  {{\"name\":%q,", fmt.tprint(v.id))
		if _, is_union := runtime.type_info_base(v).variant.(runtime.Type_Info_Union); is_union {
			strings.write_string(&b, "\"variants\":")
			variants(v)
		} else {
			strings.write_string(&b, "\"fields\":")
			table(net.fields_of(v.id, ""))
		}
		strings.write_string(&b, "}")
	}
	strings.write_string(&b, "]")
}

enum_names :: proc(name: string, id: typeid) {
	fmt.sbprintf(&b, "\n  %q: [", name)
	for n, i in reflect.enum_field_names(id) {
		if i > 0 do strings.write_string(&b, ",")
		fmt.sbprintf(&b, "%q", n)
	}
	strings.write_string(&b, "]")
}

main :: proc() {
	strings.builder_init(&b)
	fmt.sbprintf(&b, "{{\n\"version\": %d,\n", net.VERSION)
	fmt.sbprintf(&b, "\"constants\": {{\"MTU\":%d,\"MAX_PLAYERS\":%d,\"MAX_THINGS\":%d,\"TICK_RATE\":%d,\"WIRE_PER_PACKET\":%d,\"WIRE_QUEUE\":%d,\"STREAM_RING\":%d,\"STREAM_WHOLE_AFTER\":%d,\"CHANNELS\":%d}},\n",
		net.MTU, game.MAX_PLAYERS, game.MAX_THINGS, game.TICK_RATE, net.WIRE_PER_PACKET, net.WIRE_QUEUE, net.STREAM_RING, net.STREAM_WHOLE_AFTER, net.CHANNELS)
	// the messages' own sizes (core/network/message.odin), which their routines read by
	fmt.sbprintf(&b, "\"sizes\": {{\"Name\":%d,\"Password\":%d,\"Hwid\":%d,\"Text\":%d,\"Map_Name\":%d,\"Reason\":%d,\"Map_Art_Path\":%d,\"Shown_Text\":%d,\"MAP_HASH_SIZE\":%d,\"MAP_PART\":%d,\"MAP_MAX\":%d,\"MAP_FETCH_MAX\":%d,\"MAP_ART_MAX\":%d,\"TEXT_LAYERS\":%d}},\n",
		len(net.Name{}.chars), len(net.Password{}.chars), len(net.Hwid{}.chars), len(net.Text{}.chars), len(net.Map_Name{}.chars),
		len(net.Reason{}.chars), len(net.Map_Art_Path{}.chars), len(net.Shown_Text{}.chars), net.MAP_HASH_SIZE, net.MAP_PART,
		net.MAP_MAX, net.MAP_FETCH_MAX, net.MAP_ART_MAX, net.TEXT_LAYERS)
	strings.write_string(&b, "\"tables\": {")
	tables := [?]struct{name: string, fields: net.Field_Table}{
		{"soldier_owned", net.SOLDIER_OWNED_FIELDS},
		{"soldier_served", net.SOLDIER_SERVED_FIELDS},
		{"soldier_loadout", net.SOLDIER_LOADOUT_FIELDS},
		{"thing", net.THING_FIELDS},
		{"look", net.LOOK_FIELDS},
		{"weapons", net.WEAPONS_FIELDS},
		{"round", net.ROUND_FIELDS},
	}
	for t, i in tables {
		if i > 0 do strings.write_string(&b, ",")
		fmt.sbprintf(&b, "\n  %q: ", t.name)
		table(t.fields)
	}
	strings.write_string(&b, "},\n\"words\": ")
	variants(type_info_of(game.Word))
	strings.write_string(&b, ",\n\"enums\": {")
	enum_names("Msg_Kind", net.Msg_Kind)
	strings.write_string(&b, ",")
	enum_names("Snap_Word", net.Snap_Word)
	strings.write_string(&b, ",")
	enum_names("Chat_Kind", net.Chat_Kind)
	strings.write_string(&b, ",")
	enum_names("Vote_Kind", net.Vote_Kind)
	strings.write_string(&b, ",")
	enum_names("Text_Place", net.Text_Place)
	strings.write_string(&b, ",")
	enum_names("Round_Wire_Phase", net.Round_Wire_Phase)
	strings.write_string(&b, ",")
	enum_names("Team", res.Team)
	strings.write_string(&b, ",")
	enum_names("Weapon", res.Weapon)
	strings.write_string(&b, ",")
	enum_names("Animation_Id", res.Animation_Id)
	strings.write_string(&b, ",")
	enum_names("Gostek", res.Gostek)
	strings.write_string(&b, ",")
	enum_names("Hair_Style", res.Hair_Style)
	strings.write_string(&b, ",")
	enum_names("Head_Style", res.Head_Style)
	strings.write_string(&b, ",")
	enum_names("Eyewear", res.Eyewear)
	strings.write_string(&b, ",")
	enum_names("Chain_Style", res.Chain_Style)
	strings.write_string(&b, ",")
	enum_names("Thing_Kind", game.Thing_Kind)
	strings.write_string(&b, ",")
	enum_names("Explosion_Kind", game.Explosion_Kind)
	strings.write_string(&b, ",")
	enum_names("Stance", game.Stance)
	strings.write_string(&b, ",")
	enum_names("Button", game.Button)
	strings.write_string(&b, "\n}\n}\n")
	fmt.print(strings.to_string(b))
}
