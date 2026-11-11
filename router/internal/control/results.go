package control

import (
	"router/internal/routerpb"
	"router/internal/routes"
)

func newSuccessResult(id string) *routerpb.ResultMessage {
	return &routerpb.ResultMessage{
		Id:      id,
		Outcome: &routerpb.ResultMessage_Success{Success: &routerpb.Success{}},
	}
}

func newPortResult(id string, port int) *routerpb.ResultMessage {
	return &routerpb.ResultMessage{
		Id: id,
		Outcome: &routerpb.ResultMessage_Success{
			Success: &routerpb.Success{Port: new(uint32(port))},
		},
	}
}

func newFailureResult(id string, err error) *routerpb.ResultMessage {
	return &routerpb.ResultMessage{
		Id: id,
		Outcome: &routerpb.ResultMessage_Failure{
			Failure: &routerpb.Failure{Name: "Error", Message: err.Error()},
		},
	}
}

func toRouteEntries(entries []*routerpb.RouteEntry) []routes.Entry {
	converted := make([]routes.Entry, len(entries))
	for i, entry := range entries {
		converted[i] = routes.Entry{Name: entry.GetName(), SocketPath: entry.GetSocketPath()}
	}
	return converted
}
