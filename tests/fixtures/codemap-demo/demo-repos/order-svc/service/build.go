package service

import (
	"context"
	"errors"
	"time"

	pb "shop/order-svc/api"
)

var ErrPriceMismatch = errors.New("price count mismatch")

func (s *Service) buildOrder(ctx context.Context, req *pb.CreateOrderReq, stock *StockResult) (*Order, error) {
	o := &Order{}

	u, err := s.userRepo.Get(ctx, req.UserId)
	if err != nil {
		return nil, err
	}
	o.UserID = u.ID

	if len(stock.Prices) != len(req.Items) {
		return nil, ErrPriceMismatch
	}

	prices := s.priceCache.MGet(ctx, skuIDs(req.Items)) // 缓存价，可能过期

	for i, it := range req.Items {
		price := prices[i]
		o.Items = append(o.Items, &OrderItem{SkuID: it.SkuId, Qty: it.Qty, Price: price})
		o.ItemsAmount += price * int64(it.Qty)
	}

	o.PayAmount = o.ItemsAmount

	o.ID = s.idgen.Next() // snowflake
	o.Status = StatusPending
	o.CreatedAt = time.Now()

	return o, nil
}
