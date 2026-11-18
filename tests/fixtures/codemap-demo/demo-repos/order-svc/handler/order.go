package handler

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "shop/order-svc/api"
	"shop/order-svc/service"
)

type Handler struct {
	svc *service.Service
}

// CreateOrder 下单入口：校验参数，交给 service 创建订单，组装响应
func (h *Handler) CreateOrder(ctx context.Context, req *pb.CreateOrderReq) (*pb.CreateOrderResp, error) {
	if err := validate(req); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	o, err := h.svc.Create(ctx, req)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &pb.CreateOrderResp{
		OrderId:   o.ID,
		PayAmount: o.PayAmount,
		ExpireAt:  o.CreatedAt.Add(15 * time.Minute).Unix(),
	}, nil
}
