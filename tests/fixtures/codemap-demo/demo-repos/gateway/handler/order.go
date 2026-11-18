package handler

import (
	"net/http"

	pb "shop/order-svc/api"
)

// PlaceOrderBody 用户端下单的请求体
type PlaceOrderBody struct {
	Items  []struct{ Sku, Qty int64 } `json:"items"`
	AddrID int64                      `json:"addrId"`
}

type PlaceOrderResult struct {
	OrderID   string  `json:"orderId"`
	PayAmount float64 `json:"payAmount"` // 元
}

func PlaceOrder(w http.ResponseWriter, r *http.Request, cli pb.OrderServiceClient) {}
