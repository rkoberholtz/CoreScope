package main

import (
	"encoding/json"
	"testing"
	"time"
)

// Every observation proves one direction of reception: an observer heard the
// last hop, or the first hop heard an advert's originator. The graph keeps
// which end heard which, and the API calls a link bidirectional only when
// both directions have been seen.

// heardBy returns how often pk received the other end of e.
func heardBy(t *testing.T, e *NeighborEdge, pk string) int {
	t.Helper()
	switch pk {
	case e.NodeA:
		return e.HeardByA
	case e.NodeB:
		return e.HeardByB
	}
	t.Fatalf("%s is not an end of %s-%s", pk, e.NodeA, e.NodeB)
	return 0
}

func edgeBetween(t *testing.T, g *NeighborGraph, a, b string) *NeighborEdge {
	t.Helper()
	for _, e := range g.AllEdges() {
		if (e.NodeA == a && e.NodeB == b) || (e.NodeA == b && e.NodeB == a) {
			return e
		}
	}
	t.Fatalf("no edge %s-%s", a, b)
	return nil
}

func TestNeighborDirection_AdvertPathIsOneWay(t *testing.T) {
	// ADVERT from X via R1, heard by Obs: R1 heard X, Obs heard R1.
	nodes := []nodeInfo{
		{Role: "repeater", PublicKey: "aaaa1111", Name: "X"},
		{Role: "repeater", PublicKey: "r1aabbcc", Name: "R1"},
		{Role: "repeater", PublicKey: "obs00001", Name: "Obs"},
	}
	tx := ngMakeTx(1, 4, ngFromNodeJSON("aaaa1111"), []*StoreObs{
		ngMakeObs("obs00001", `["r1aa"]`, nowStr, nil),
	})
	g := BuildFromStore(ngTestStore(nodes, []*StoreTx{tx}))

	xr := edgeBetween(t, g, "aaaa1111", "r1aabbcc")
	if heardBy(t, xr, "r1aabbcc") != 1 || heardBy(t, xr, "aaaa1111") != 0 {
		t.Errorf("X-R1: want R1 heard X once and not the reverse, got A=%d B=%d", xr.HeardByA, xr.HeardByB)
	}
	or := edgeBetween(t, g, "obs00001", "r1aabbcc")
	if heardBy(t, or, "obs00001") != 1 || heardBy(t, or, "r1aabbcc") != 0 {
		t.Errorf("Obs-R1: want Obs heard R1 once and not the reverse, got A=%d B=%d", or.HeardByA, or.HeardByB)
	}
}

func TestNeighborDirection_ZeroHopObserverHeardOriginator(t *testing.T) {
	nodes := []nodeInfo{
		{Role: "repeater", PublicKey: "aaaa1111", Name: "X"},
		{Role: "repeater", PublicKey: "obs00001", Name: "Obs"},
	}
	tx := ngMakeTx(1, 4, ngFromNodeJSON("aaaa1111"), []*StoreObs{
		ngMakeObs("obs00001", `[]`, nowStr, nil),
	})
	g := BuildFromStore(ngTestStore(nodes, []*StoreTx{tx}))

	e := edgeBetween(t, g, "aaaa1111", "obs00001")
	if heardBy(t, e, "obs00001") != 1 || heardBy(t, e, "aaaa1111") != 0 {
		t.Errorf("want Obs heard X once and not the reverse, got A=%d B=%d", e.HeardByA, e.HeardByB)
	}
}

func TestNeighborDirection_BothDirectionsSeen(t *testing.T) {
	// X and Y are both observers. Y hears X's zero-hop advert, and X hears
	// Y's: the link is proven both ways.
	nodes := []nodeInfo{
		{Role: "repeater", PublicKey: "aaaa1111", Name: "X"},
		{Role: "repeater", PublicKey: "bbbb2222", Name: "Y"},
	}
	txs := []*StoreTx{
		ngMakeTx(1, 4, ngFromNodeJSON("aaaa1111"), []*StoreObs{ngMakeObs("bbbb2222", `[]`, nowStr, nil)}),
		ngMakeTx(2, 4, ngFromNodeJSON("bbbb2222"), []*StoreObs{ngMakeObs("aaaa1111", `[]`, nowStr, nil)}),
		ngMakeTx(3, 4, ngFromNodeJSON("bbbb2222"), []*StoreObs{ngMakeObs("aaaa1111", `[]`, nowStr, nil)}),
	}
	g := BuildFromStore(ngTestStore(nodes, txs))

	e := edgeBetween(t, g, "aaaa1111", "bbbb2222")
	if heardBy(t, e, "bbbb2222") != 1 || heardBy(t, e, "aaaa1111") != 2 {
		t.Errorf("want Y heard X once and X heard Y twice, got A=%d B=%d", e.HeardByA, e.HeardByB)
	}
}

func TestNeighborDirection_SurvivesResolveWithSwappedEnds(t *testing.T) {
	// As TestBuildNeighborGraph_ConfidenceAutoResolve: X's adverts go out
	// through an ambiguous first hop "a300" that resolves to CandidateA.
	// "a3001111" sorts before "aaaa1111", so resolving swaps which end is
	// NodeA; the counts must follow their ends: CandidateA heard X, three
	// times, and X never heard CandidateA.
	nodes := []nodeInfo{
		{Role: "repeater", PublicKey: "aaaa1111", Name: "NodeX"},
		{Role: "repeater", PublicKey: "n1111111", Name: "N1"},
		{Role: "repeater", PublicKey: "n2222222", Name: "N2"},
		{Role: "repeater", PublicKey: "n3333333", Name: "N3"},
		{Role: "repeater", PublicKey: "a3001111", Name: "CandidateA"},
		{Role: "repeater", PublicKey: "a3002222", Name: "CandidateB"},
		{Role: "repeater", PublicKey: "obs00001", Name: "Observer"},
	}
	var txs []*StoreTx
	id := 1
	for _, from := range []string{"aaaa1111", "a3001111"} {
		for _, hop := range []string{"n111", "n222", "n333"} {
			txs = append(txs, ngMakeTx(id, 4, ngFromNodeJSON(from), []*StoreObs{
				ngMakeObs("obs00001", `["`+hop+`"]`, nowStr, nil),
			}))
			id++
		}
	}
	for i := 0; i < 3; i++ {
		txs = append(txs, ngMakeTx(id, 4, ngFromNodeJSON("aaaa1111"), []*StoreObs{
			ngMakeObs("obs00001", `["a300"]`, nowStr, nil),
		}))
		id++
	}
	g := BuildFromStore(ngTestStore(nodes, txs))

	e := edgeBetween(t, g, "aaaa1111", "a3001111")
	if e.Ambiguous {
		t.Fatal("edge should have been resolved")
	}
	if e.NodeA != "a3001111" {
		t.Fatalf("test premise: CandidateA should be NodeA after resolving, got %s", e.NodeA)
	}
	if heardBy(t, e, "a3001111") != 3 || heardBy(t, e, "aaaa1111") != 0 {
		t.Errorf("want CandidateA heard X 3 times and not the reverse, got A=%d B=%d", e.HeardByA, e.HeardByB)
	}
}

func TestNeighborDirection_ResolveMergesIntoExistingEdge(t *testing.T) {
	g := NewNeighborGraph()
	ts := time.Now()
	// Known edge: Y heard X twice.
	g.upsertHeard("aaaa1111", "bbbb2222", "bbbb2222", "", "obs", nil, ts)
	g.upsertHeard("aaaa1111", "bbbb2222", "bbbb2222", "", "obs", nil, ts)
	// Ambiguous edge: X heard prefix "bb" once.
	cands := []nodeInfo{{PublicKey: "bbbb2222"}, {PublicKey: "bbbb3333"}}
	g.upsertEdgeWithCandidates("aaaa1111", "bb", cands, true, "obs", nil, ts, map[string]string{})

	g.mu.Lock()
	key := makeEdgeKey("aaaa1111", "prefix:bb")
	g.resolveEdge(key, g.edges[key], "aaaa1111", "bbbb2222")
	g.mu.Unlock()

	e := edgeBetween(t, g, "aaaa1111", "bbbb2222")
	if heardBy(t, e, "bbbb2222") != 2 || heardBy(t, e, "aaaa1111") != 1 {
		t.Errorf("want Y heard X twice and X heard Y once, got A=%d B=%d", e.HeardByA, e.HeardByB)
	}
}

func TestNeighborGraphAPI_BidirectionalOnlyWhenBothWaysSeen(t *testing.T) {
	now := time.Now()
	oneWay := newEdge("aaaa", "bbbb", "bb", 10, now)
	oneWay.HeardByB = 10
	twoWay := newEdge("bbbb", "cccc", "cc", 10, now)
	twoWay.HeardByA, twoWay.HeardByB = 4, 6
	// Restored from the persisted snapshot: direction unknown.
	unknown := newEdge("cccc", "dddd", "dd", 10, now)
	srv := makeTestServer(makeTestGraph(oneWay, twoWay, unknown))

	rr := serveRequest(srv, "GET", "/api/analytics/neighbor-graph?min_count=1&min_score=0")
	var resp NeighborGraphResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	got := map[string]GraphEdge{}
	for _, e := range resp.Edges {
		got[e.Source+"-"+e.Target] = e
	}
	cases := []struct {
		key        string
		bidir      bool
		bySrc, byT int
	}{
		{"aaaa-bbbb", false, 0, 10},
		{"bbbb-cccc", true, 4, 6},
		{"cccc-dddd", false, 0, 0},
	}
	for _, c := range cases {
		e, ok := got[c.key]
		if !ok {
			t.Errorf("missing edge %s", c.key)
			continue
		}
		if e.Bidirectional != c.bidir || e.HeardBySource != c.bySrc || e.HeardByTarget != c.byT {
			t.Errorf("%s: got bidirectional=%v heard_by_source=%d heard_by_target=%d, want %v %d %d",
				c.key, e.Bidirectional, e.HeardBySource, e.HeardByTarget, c.bidir, c.bySrc, c.byT)
		}
	}
}
