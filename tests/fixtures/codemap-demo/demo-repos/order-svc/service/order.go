package service

import (
	"context"
	"errors"

	pb "shop/order-svc/api"
	inv "shop/inventory-svc/api"
	"shop/order-svc/mq"
)

var ErrOutOfStock = errors.New("out of stock")

// StockResult 锁库存的结果，交给 buildOrder
type StockResult struct {
	LockID string
	Prices []int64 // 库存服务锁定时返回的实时价
}

func (s *Service) Create(ctx context.Context, req *pb.CreateOrderReq) (*Order, error) {
	stock, err := s.lockStock(ctx, req.Items)
	if err != nil {
		return nil, err
	}
	o, err := s.buildOrder(ctx, req, stock)
	if err != nil {
		return nil, err
	}
	if err := s.repo.Save(ctx, o); err != nil {
		return nil, err
	}
	return o, s.publish(ctx, o)
}

func (s *Service) lockStock(ctx context.Context, items []*pb.Item) (*StockResult, error) {
	resp, err := s.invCli.LockStock(ctx, &inv.LockStockReq{Items: toInvItems(items), TTL: 900})
	if err != nil {
		return nil, err
	}
	if !resp.Ok {
		return nil, ErrOutOfStock
	}
	return &StockResult{LockID: resp.LockId, Prices: resp.Prices}, nil
}

// MarkPaid 条件更新：只有待支付的订单才改成已支付，重复消费时影响 0 行
func (s *Service) MarkPaid(ctx context.Context, evt *mq.PaySucceeded) (bool, error) {
	n, err := s.repo.UpdateStatus(ctx, evt.OrderID, StatusPending, StatusPaid)
	return n > 0, err
}
