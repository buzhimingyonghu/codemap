package handler

import (
	"errors"

	pb "shop/order-svc/api"
)

var (
	ErrNoUser = errors.New("user_id is required")
	ErrItems  = errors.New("items must be 1~50")
	ErrQty    = errors.New("qty must be positive")
)

func validate(req *pb.CreateOrderReq) error {
	if req.UserId == 0 {
		return ErrNoUser
	}
	if len(req.Items) == 0 || len(req.Items) > 50 {
		return ErrItems
	}
	for _, it := range req.Items {
		if it.Qty <= 0 {
			return ErrQty
		}
	}
	return nil
}
